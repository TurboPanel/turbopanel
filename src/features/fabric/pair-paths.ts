/**
 * How each pair of servers in the organization talks, in plain words, for the
 * TurboFabric page (`GET /organizations/:id/fabric` `pairs`).
 *
 * - `lan`: they share a trusted datacenter network and both daemons route over
 *   it, so there is no tunnel between them.
 * - `fabric`: a TurboFabric tunnel carries their traffic.
 * - `fabric_over_untrusted_lan`: the tunnel runs over a shared network marked
 *   untrusted (encrypted over the LAN).
 * - `none`: no private path (TurboFabric off, paused, switched off, or no
 *   path found).
 */
import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { datacenter, server } from '../../db/schema.ts'
import { partitionSharedDatacenters } from '../net/private-endpoint.ts'
import {
  type EndpointAddressCaches,
  type FabricRecord,
  isFabricPaused,
  listFabricRelays,
  loadEndpointCaches,
  pairSharesTrustedLan,
  planRelayPath,
  type RelayRecord,
} from './fabric-records.ts'
import { loadLanPairInputs } from './lan-pairs.ts'

export type FabricPairPath = 'lan' | 'fabric' | 'fabric_over_untrusted_lan' | 'none'

export type FabricPairApiRow = {
  fromServerId: string
  toServerId: string
  path: FabricPairPath
  reason: string
}

type PairContext = {
  fabric: FabricRecord | null
  relayByServer: ReadonlyMap<string, RelayRecord>
  gateways: readonly RelayRecord[]
  caches: EndpointAddressCaches
  names: ReadonlyMap<string, string>
  datacenterNames: ReadonlyMap<string, string>
}

function sharedNetworks(
  ctx: PairContext,
  a: string,
  b: string
): { trusted: string[]; untrusted: string[] } {
  return partitionSharedDatacenters(
    ctx.caches.datacenterMembershipsByServer.get(a) ?? [],
    ctx.caches.datacenterMembershipsByServer.get(b) ?? [],
    ctx.caches.policyByDatacenter
  )
}

function networkName(ctx: PairContext, datacenterId: string | undefined): string {
  if (!datacenterId) return 'datacenter network'
  return ctx.datacenterNames.get(datacenterId) ?? datacenterId
}

function serverName(ctx: PairContext, id: string): string {
  return ctx.names.get(id) ?? id
}

function row(a: string, b: string, path: FabricPairPath, reason: string): FabricPairApiRow {
  return { fromServerId: a, toServerId: b, path, reason }
}

/** Why there is no tunnel to fall back on, or null when both are in a running mesh. */
function meshMissingReason(ctx: PairContext, a: string, b: string): string | null {
  if (!ctx.fabric) return 'TurboFabric is off'
  if (isFabricPaused(ctx.fabric)) return 'TurboFabric is paused'
  const off = [a, b].filter((id) => !ctx.relayByServer.has(id))
  if (off.length === 0) return null
  return `TurboFabric is switched off for ${off.map((id) => serverName(ctx, id)).join(' and ')}`
}

function tunnelPath(ctx: PairContext, a: string, b: string): FabricPairApiRow {
  const self = ctx.relayByServer.get(a)
  const other = ctx.relayByServer.get(b)
  if (!self || !other) return row(a, b, 'none', 'These servers have no private path.')
  const plan = planRelayPath({
    self,
    other,
    caches: ctx.caches,
    gateways: ctx.gateways,
    preferredGatewayIds: self.preferredGatewayIds,
  })
  if (plan.selected.kind === 'unreachable') {
    return row(a, b, 'none', 'TurboFabric found no path between these servers.')
  }
  if (plan.selected.untrusted) {
    return row(
      a,
      b,
      'fabric_over_untrusted_lan',
      `Shared network "${networkName(ctx, plan.selected.datacenterId)}" is untrusted: TurboFabric runs over it, encrypted.`
    )
  }
  if (sharedNetworks(ctx, a, b).trusted.length > 0) {
    return row(
      a,
      b,
      'fabric',
      'Same trusted network, but a daemon is too old to skip the tunnel: TurboFabric runs over the LAN until both servers are updated.'
    )
  }
  return row(a, b, 'fabric', 'Different datacenters: traffic goes through TurboFabric.')
}

/** The path and reason for one pair. */
export function describeFabricPair(ctx: PairContext, a: string, b: string): FabricPairApiRow {
  if (pairSharesTrustedLan(a, b, ctx.caches)) {
    const [first] = sharedNetworks(ctx, a, b).trusted
    return row(
      a,
      b,
      'lan',
      `Same trusted network "${networkName(ctx, first)}": traffic stays on the LAN, no tunnel.`
    )
  }
  const missing = meshMissingReason(ctx, a, b)
  if (missing) {
    const shared = sharedNetworks(ctx, a, b)
    const where =
      shared.trusted.length > 0
        ? 'these servers share a trusted network but a daemon is too old to route container networks over it'
        : 'these servers are in different datacenters'
    return row(
      a,
      b,
      'none',
      `${missing} and ${where}, so they have no private path for container networks.`
    )
  }
  return tunnelPath(ctx, a, b)
}

async function loadNames(
  db: Db,
  organizationId: string
): Promise<{ ids: string[]; names: Map<string, string> }> {
  const rows = await db
    .select({ id: server.id, name: server.name, hostname: server.hostname })
    .from(server)
    .where(eq(server.organizationId, organizationId))
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id))
  return {
    ids: sorted.map((entry) => entry.id),
    names: new Map(sorted.map((entry) => [entry.id, entry.name ?? entry.hostname ?? entry.id])),
  }
}

async function loadDatacenterNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: datacenter.id, name: datacenter.name })
    .from(datacenter)
    .where(inArray(datacenter.id, [...ids]))
  return new Map(rows.map((entry) => [entry.id, entry.name ?? entry.id]))
}

/** One row per pair of org servers (each pair once, ordered by server id). */
export async function loadFabricPairs(
  db: Db,
  params: { organizationId: string; fabric: FabricRecord | null }
): Promise<FabricPairApiRow[]> {
  const { ids, names } = await loadNames(db, params.organizationId)
  if (ids.length < 2) return []
  const [{ caches: endpointCaches }, lanInputs, relays] = await Promise.all([
    loadEndpointCaches(db, ids),
    loadLanPairInputs(db, ids),
    params.fabric ? listFabricRelays(db, params.fabric.id) : Promise.resolve([]),
  ])
  const caches: EndpointAddressCaches = {
    ...endpointCaches,
    datacenterMembershipsByServer: new Map(
      [...lanInputs.membershipsByServer].map(([id, pins]) => [id, [...pins]])
    ),
    policyByDatacenter: new Map(lanInputs.policiesByDatacenter),
    lanRouteServerIds: lanInputs.lanRouteServerIds,
  }
  const ctx: PairContext = {
    fabric: params.fabric,
    relayByServer: new Map(relays.map((relayRow) => [relayRow.serverId, relayRow])),
    gateways: relays.filter((relayRow) => relayRow.role === 'gateway' && relayRow.publicKey),
    caches,
    names,
    datacenterNames: await loadDatacenterNames(db, [...caches.policyByDatacenter.keys()]),
  }
  const out: FabricPairApiRow[] = []
  for (const [index, a] of ids.entries()) {
    for (const b of ids.slice(index + 1)) out.push(describeFabricPair(ctx, a, b))
  }
  return out
}
