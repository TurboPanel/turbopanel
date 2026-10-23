/**
 * "Addresses clients use": loading and saving. Rules and precedence live in
 * `./client-addresses-pure.ts`.
 *
 * Readers: the managed database connection strings and endpoints
 * (`features/managed/routes-helpers.ts`), the managed external dial host
 * (`features/managed/access-address.ts`) and the database listener
 * certificate names (`features/managed/ingress-desired.ts`). Writer: the
 * `PUT /servers/:id/addresses` route.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { clientAddress, datacenter, ip, server } from '../../db/schema.ts'
import { reportedIpsFromServerMetadata } from '../../contracts/server-addresses.ts'
import { inetAddressToString, parseIpVersion } from '../../lib/ip-address.ts'
import { pinLinkIsDown } from './pin-link-state.ts'
import {
  type ClientAddressDatacenterPin,
  type ClientAddressEntry,
  type ClientAddressFacts,
  parseClientAddressOptions,
  resolveClientAddresses,
  type ServerClientAddresses,
} from './client-addresses-pure.ts'

/** Saved operator entries for a server. */
export async function loadClientAddressEntries(
  db: Db,
  serverId: string
): Promise<ClientAddressEntry[]> {
  const rows = await db
    .select({
      scope: clientAddress.scope,
      datacenterId: clientAddress.datacenterId,
      hostname: clientAddress.hostname,
      addressV4: clientAddress.addressV4,
      addressV6: clientAddress.addressV6,
      options: clientAddress.options,
      isPrimary: clientAddress.isPrimary,
    })
    .from(clientAddress)
    .where(eq(clientAddress.serverId, serverId))
    .orderBy(asc(clientAddress.createdAt))
  return rows.map((row) => ({
    scope: row.scope === 'datacenter' ? 'datacenter' : 'public',
    datacenterId: row.datacenterId,
    hostname: row.hostname,
    addressV4: inetAddressToString(row.addressV4) ?? null,
    addressV6: inetAddressToString(row.addressV6) ?? null,
    ports: parseClientAddressOptions(row.options).ports,
    primary: row.isPrimary,
  }))
}

/** The first address of each family in `rows` (already oldest first). */
function firstPerFamily(rows: readonly { address: unknown }[]): {
  v4: string | null
  v6: string | null
} {
  const out: { v4: string | null; v6: string | null } = { v4: null, v6: null }
  for (const row of rows) {
    const address = inetAddressToString(row.address)
    if (!address) continue
    const version = parseIpVersion(address)
    if (version === 4) out.v4 ??= address
    if (version === 6) out.v6 ??= address
  }
  return out
}

/** Oldest public `ip` row of each family. */
async function loadPublicIpByFamily(
  db: Db,
  serverId: string
): Promise<{ v4: string | null; v6: string | null }> {
  const rows = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'public')))
    .orderBy(asc(ip.createdAt))
  return firstPerFamily(rows)
}

/** The server's pins, one summary per datacenter it belongs to. */
export async function loadClientAddressDatacenterPins(
  db: Db,
  serverId: string
): Promise<ClientAddressDatacenterPin[]> {
  const rows = await db
    .select({
      address: ip.address,
      datacenterId: ip.datacenterId,
      metadata: ip.metadata,
      name: datacenter.name,
      priority: datacenter.priority,
      addressPreference: datacenter.addressPreference,
    })
    .from(ip)
    .innerJoin(datacenter, eq(datacenter.id, ip.datacenterId))
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'datacenter'), isNotNull(ip.datacenterId)))
    .orderBy(asc(ip.createdAt))
  const byDatacenter = new Map<string, typeof rows>()
  for (const row of rows) {
    if (!row.datacenterId) continue
    byDatacenter.set(row.datacenterId, [...(byDatacenter.get(row.datacenterId) ?? []), row])
  }
  return [...byDatacenter].map(([datacenterId, pins]) => ({
    datacenterId,
    datacenterName: pins[0]!.name ?? 'Datacenter',
    addressPreference: pins[0]!.addressPreference === 'ipv4' ? 'ipv4' : 'ipv6',
    priority: pins[0]!.priority,
    // A pin whose network link is down is not where clients arrive, the same
    // rule the public side applies to reported interfaces. The server still
    // belongs to the datacenter, so the side stays (a DNS name still counts).
    ...firstPerFamily(pins.filter((row) => !pinLinkIsDown(row.metadata))),
  }))
}

/** Everything {@link resolveClientAddresses} reads; `null` when the server does not exist. */
export async function loadClientAddressFacts(
  db: Db,
  serverId: string
): Promise<ClientAddressFacts | null> {
  const [row] = await db
    .select({ hostname: server.hostname, metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!row) return null
  const [saved, publicIp, pins] = await Promise.all([
    loadClientAddressEntries(db, serverId),
    loadPublicIpByFamily(db, serverId),
    loadClientAddressDatacenterPins(db, serverId),
  ])
  return {
    linuxHostname: row.hostname?.trim().toLowerCase() || null,
    saved,
    publicIp,
    reportedIps: reportedIpsFromServerMetadata(row.metadata) ?? [],
    pins,
  }
}

/** Every side of the server with what the panel will use for it. */
export async function loadServerClientAddresses(
  db: Db,
  serverId: string
): Promise<ServerClientAddresses> {
  const facts = await loadClientAddressFacts(db, serverId)
  if (!facts) return { linuxHostname: null, entries: [] }
  return resolveClientAddresses(facts)
}

/**
 * Replace every saved entry of the server with `entries`, in one transaction
 * so the one-primary and one-per-side unique indexes never see a half-written
 * list. Entries must already be validated (`parseClientAddressesBody`).
 */
export async function saveClientAddressEntries(
  db: Db,
  params: Readonly<{
    organizationId: string
    serverId: string
    entries: readonly ClientAddressEntry[]
  }>
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize concurrent saves for one server: without the row lock two
    // replace-alls interleave and the second insert trips the one-per-side
    // unique index instead of simply winning.
    await tx
      .select({ id: server.id })
      .from(server)
      .where(eq(server.id, params.serverId))
      .for('update')
    await tx.delete(clientAddress).where(eq(clientAddress.serverId, params.serverId))
    if (params.entries.length === 0) return
    await tx.insert(clientAddress).values(
      params.entries.map((entry) => ({
        organizationId: params.organizationId,
        serverId: params.serverId,
        scope: entry.scope,
        datacenterId: entry.datacenterId,
        hostname: entry.hostname,
        addressV4: entry.addressV4,
        addressV6: entry.addressV6,
        options: Object.keys(entry.ports).length > 0 ? { ports: entry.ports } : null,
        isPrimary: entry.primary,
      }))
    )
  })
}

/**
 * Forget datacenter entries of `serverIds` whose server no longer has a pin in
 * that datacenter. Called when a server leaves a datacenter and before it joins
 * one, so an entry saved for an earlier membership never silently returns.
 */
export async function pruneClientAddressesWithoutPin(
  db: Db,
  serverIds: readonly string[]
): Promise<void> {
  if (serverIds.length === 0) return
  await db
    .delete(clientAddress)
    .where(
      and(
        inArray(clientAddress.serverId, [...serverIds]),
        eq(clientAddress.scope, 'datacenter'),
        sql`NOT EXISTS (SELECT 1 FROM ${ip} WHERE ${ip.serverId} = ${clientAddress.serverId} AND ${ip.datacenterId} = ${clientAddress.datacenterId} AND ${ip.scope} = 'datacenter')`
      )
    )
}
