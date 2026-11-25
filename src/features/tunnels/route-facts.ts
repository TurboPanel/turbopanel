/**
 * Loads the facts the route builder needs for one organization: for every
 * tunnel, which servers carry it and where each carried name's site runs, and
 * every server's peer-hop addresses (see `loadServerAddresses`).
 */
import { and, eq, inArray, isNotNull, ne, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { datacenter, deployment, doorway, hosting, ip, service, tls } from '../../db/schema.ts'
import { resolveHostingProxy, type HostingOptions } from '../hostings/hosting-options.ts'
import { compareText } from './order.ts'
import { hostingIdsOfOrganization } from './hosting-scope.ts'
import { carryingServers, listTunnels } from './lifecycle.ts'
import {
  unroutedReasons,
  type DoorwayFact,
  type ServerAddresses,
  type TunnelFact,
} from './route-builder.ts'

export type RoutingFacts = {
  tunnels: TunnelFact[]
  addresses: Map<string, ServerAddresses>
}

/** `10.0.0.1/32` and `fd00::1/128` as `10.0.0.1` and `fd00::1`; anything else unchanged. */
function bareAddress(value: string): string {
  return value.replace(/\/(32|128)$/, '')
}

/** Order one server's addresses: the datacenter's preferred family first, then by text. */
function orderAddresses(addresses: string[], preference: string): string[] {
  const wantV6 = preference === 'ipv6'
  return [...new Set(addresses)].sort((a, b) => {
    const aFirst = a.includes(':') === wantV6
    const bFirst = b.includes(':') === wantV6
    if (aFirst !== bFirst) return aFirst ? -1 : 1
    return a < b ? -1 : 1
  })
}

/**
 * Each server's addresses for the peer hop: its datacenter network addresses
 * by datacenter, and its dedicated public addresses (shared ones are never
 * used). Which of them two servers use together is decided per pair by the
 * route builder. A server with no address is absent.
 */
export async function loadServerAddresses(
  db: Db,
  organizationId: string,
  serverIds: readonly string[]
): Promise<Map<string, ServerAddresses>> {
  const book = new Map<string, ServerAddresses>()
  if (serverIds.length === 0) return book
  const rows = await db
    .select({
      serverId: ip.serverId,
      address: ip.address,
      scope: ip.scope,
      datacenterId: ip.datacenterId,
      preference: datacenter.addressPreference,
    })
    .from(ip)
    .leftJoin(datacenter, eq(datacenter.id, ip.datacenterId))
    .where(
      and(
        eq(ip.organizationId, organizationId),
        isNotNull(ip.serverId),
        inArray(ip.serverId, [...serverIds]),
        or(eq(ip.scope, 'datacenter'), and(eq(ip.scope, 'public'), eq(ip.allocation, 'dedicated')))
      )
    )
  const datacenters = new Map<string, Map<string, { list: string[]; preference: string }>>()
  const publics = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.serverId) continue
    const address = bareAddress(String(r.address))
    if (r.scope === 'public') {
      publics.set(r.serverId, [...(publics.get(r.serverId) ?? []), address])
      continue
    }
    if (!r.datacenterId) continue
    const byId = datacenters.get(r.serverId) ?? new Map()
    const entry = byId.get(r.datacenterId) ?? { list: [], preference: r.preference ?? 'ipv6' }
    entry.list.push(address)
    byId.set(r.datacenterId, entry)
    datacenters.set(r.serverId, byId)
  }
  for (const serverId of new Set([...datacenters.keys(), ...publics.keys()])) {
    const perDatacenter: Record<string, string[]> = {}
    const byId = datacenters.get(serverId) ?? new Map()
    for (const id of [...byId.keys()].toSorted(compareText)) {
      const entry = byId.get(id)
      if (entry) perDatacenter[id] = orderAddresses(entry.list, entry.preference)
    }
    book.set(serverId, {
      datacenters: perDatacenter,
      public: orderAddresses(publics.get(serverId) ?? [], 'ipv4'),
    })
  }
  return book
}

/** Servers that have a finished deployment for each environment a hosting's service lives in. */
export async function siteServersByHosting(
  db: Db,
  hostingIds: readonly string[],
  organizationId: string
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (hostingIds.length === 0) return result
  // Only hostings that really sit in this organization count as running the site.
  const own = await hostingIdsOfOrganization(db, hostingIds, organizationId)
  if (own.size === 0) return result
  const rows = await db
    .select({ hostingId: hosting.id, serverId: deployment.serverId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(deployment, eq(deployment.environmentId, service.environmentId))
    .where(and(inArray(hosting.id, [...own]), eq(deployment.status, 'applied')))
  for (const r of rows) {
    const list = result.get(r.hostingId) ?? []
    if (!list.includes(r.serverId)) list.push(r.serverId)
    result.set(r.hostingId, list.toSorted(compareText))
  }
  return result
}

export async function loadRoutingFacts(db: Db, organizationId: string): Promise<RoutingFacts> {
  const rows = await listTunnels(db, organizationId)
  const doorways = rows.length
    ? await db
        .select()
        .from(doorway)
        .where(
          inArray(
            doorway.tunnelId,
            rows.map((r) => r.id)
          )
        )
    : []
  const sites = await siteServersByHosting(
    db,
    doorways.flatMap((d) => (d.hostingId ? [d.hostingId] : [])),
    organizationId
  )
  const tunnels: TunnelFact[] = await Promise.all(
    rows.map(async (row) => {
      const carrying = await carryingServers(db, row)
      const facts: DoorwayFact[] = doorways
        .filter((d) => d.tunnelId === row.id && d.status !== 'removing')
        .map((d) => ({
          hostname: d.hostname,
          siteServerIds: d.hostingId ? (sites.get(d.hostingId) ?? []) : [],
          isLocalOnly: d.isLocalOnly,
        }))
      return { carrying, doorways: facts }
    })
  )
  const involved = new Set<string>()
  for (const t of tunnels) {
    t.carrying.forEach((id) => involved.add(id))
    t.doorways.forEach((d) => d.siteServerIds.forEach((id) => involved.add(id)))
  }
  return { tunnels, addresses: await loadServerAddresses(db, organizationId, [...involved]) }
}

/**
 * Why a name of the tunnel is not forwarded, by hostname: a name some carrying
 * server could not route (the site runs nowhere, or no server that runs it has
 * an address). Names routed everywhere have no entry.
 */
export async function loadUnroutedReasons(
  db: Db,
  organizationId: string,
  tunnelRow: Parameters<typeof carryingServers>[1]
): Promise<Map<string, string>> {
  const facts = await loadRoutingFacts(db, organizationId)
  const carriers = await carryingServers(db, tunnelRow)
  return unroutedReasons(carriers, facts.tunnels, facts.addresses)
}

/** The servers that run a site with one of the tunnel's names (its non-removing doorways), sorted. */
export async function siteServersOfTunnel(
  db: Db,
  organizationId: string,
  tunnelId: string
): Promise<string[]> {
  const rows = await db
    .select({ hostingId: doorway.hostingId, status: doorway.status })
    .from(doorway)
    .where(and(eq(doorway.tunnelId, tunnelId), isNotNull(doorway.hostingId)))
  const hostingIds = rows.flatMap((r) =>
    r.hostingId && r.status !== 'removing' ? [r.hostingId] : []
  )
  const sites = await siteServersByHosting(db, hostingIds, organizationId)
  return [...new Set([...sites.values()].flat())].toSorted(compareText)
}

/**
 * Does the daemon's lock add skip this site? It only reshapes a block that has
 * an HTTPS site with a pinned or internal certificate: a hosting on an
 * automatic (Let's Encrypt) certificate has no `tls` line, and one with
 * `forceHttps` off has no HTTPS block until a deploy makes one. Such a site
 * waits for its next deploy to lock a name added to a tunnel.
 */
export function lockAddSkipsSite(options: unknown, tlsStatus: string | null | undefined): boolean {
  const proxy = resolveHostingProxy((options ?? undefined) as HostingOptions | undefined)
  return !proxy.forceHttps || tlsStatus === 'automatic'
}

/** The servers that run a site, for a local-only name of the tunnel, that the daemon's lock add skips. */
export async function lockAddSkippedServers(
  db: Db,
  organizationId: string,
  tunnelId: string
): Promise<string[]> {
  const rows = await db
    .select({ options: hosting.options, tlsStatus: tls.status, hostingId: hosting.id })
    .from(doorway)
    .innerJoin(hosting, eq(hosting.id, doorway.hostingId))
    .leftJoin(tls, eq(tls.id, hosting.tlsId))
    .where(
      and(
        eq(doorway.tunnelId, tunnelId),
        eq(doorway.isLocalOnly, true),
        ne(doorway.status, 'removing')
      )
    )
  const skipped = rows
    .filter((r) => lockAddSkipsSite(r.options, r.tlsStatus))
    .map((r) => r.hostingId)
  const sites = await siteServersByHosting(db, [...new Set(skipped)], organizationId)
  return [...new Set([...sites.values()].flat())].toSorted(compareText)
}
