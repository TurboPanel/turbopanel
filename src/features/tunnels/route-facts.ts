/**
 * Loads the facts the route builder needs for one organization: for every
 * tunnel, which servers carry it and where each carried name's site runs, and
 * every server's datacenter addresses (exact addresses, the datacenter's
 * preferred family first).
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { datacenter, deployment, doorway, hosting, ip, service } from '../../db/schema.ts'
import { compareText } from './order.ts'
import { hostingIdsOfOrganization } from './hosting-scope.ts'
import { carryingServers, listTunnels } from './lifecycle.ts'
import type { DoorwayFact, TunnelFact } from './route-builder.ts'

export type RoutingFacts = {
  tunnels: TunnelFact[]
  addresses: Map<string, string[]>
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

export async function loadServerAddresses(
  db: Db,
  organizationId: string,
  serverIds: readonly string[]
): Promise<Map<string, string[]>> {
  const book = new Map<string, string[]>()
  if (serverIds.length === 0) return book
  const rows = await db
    .select({
      serverId: ip.serverId,
      address: ip.address,
      preference: datacenter.addressPreference,
    })
    .from(ip)
    .innerJoin(datacenter, eq(datacenter.id, ip.datacenterId))
    .where(
      and(
        eq(ip.organizationId, organizationId),
        eq(ip.scope, 'datacenter'),
        isNotNull(ip.serverId),
        inArray(ip.serverId, [...serverIds])
      )
    )
  const preferenceOf = new Map<string, string>()
  const grouped = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.serverId) continue
    preferenceOf.set(r.serverId, r.preference ?? 'ipv6')
    grouped.set(r.serverId, [...(grouped.get(r.serverId) ?? []), bareAddress(String(r.address))])
  }
  for (const [serverId, list] of grouped) {
    book.set(serverId, orderAddresses(list, preferenceOf.get(serverId) ?? 'ipv6'))
  }
  return book
}

/** Servers that have a finished deployment for each environment a hosting's service lives in. */
async function siteServersByHosting(
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
