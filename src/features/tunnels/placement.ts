/**
 * Where a tunnel's connectors run. Pure rules, no database: the caller loads
 * the facts (portals, the servers of the datacenter, servers marked as never
 * carrying tunnels) and these functions say which servers carry the tunnel.
 *
 * - `one` and `chosen`: the servers with a `run` portal.
 * - `all`: every server of the tunnel's datacenter except those with a `skip`
 *   portal. Only `all` picks up new servers by itself.
 * - A server marked "never carries tunnels" is left out of every placement.
 */
import { compareText } from './order.ts'
import type { Parsed } from './records.ts'
import { TUNNEL_PLACEMENTS, type TunnelPlacement } from './vocabulary.ts'

export type PortalFact = { serverId: string; wanted: 'run' | 'skip' }

export type PlacementFacts = {
  placement: TunnelPlacement
  portals: readonly PortalFact[]
  /** Servers of the tunnel's datacenter; only read for `all`. */
  datacenterServerIds: readonly string[]
  /** Servers marked as never carrying tunnels. */
  neverServerIds: ReadonlySet<string>
}

/** Server ids that run a connector for the tunnel, sorted so the result is stable. */
export function resolveCarryingServers(facts: PlacementFacts): string[] {
  const skipped = new Set(facts.portals.filter((p) => p.wanted === 'skip').map((p) => p.serverId))
  const running = facts.portals.filter((p) => p.wanted === 'run').map((p) => p.serverId)
  const candidates = facts.placement === 'all' ? [...facts.datacenterServerIds] : running
  const carrying = new Set(
    candidates.filter((id) => !skipped.has(id) && !facts.neverServerIds.has(id))
  )
  return [...carrying].toSorted(compareText)
}

/** Plain-words warnings about a placement; a single connector is the one that matters. */
export function placementWarnings(carrying: readonly string[]): string[] {
  if (carrying.length === 0) {
    return ['No server runs this Tunnel yet, so it carries no traffic.']
  }
  if (carrying.length === 1) {
    return [
      'Only one server runs this Tunnel. If that server is down, the sites on this Tunnel are unreachable. Add a second server to keep them up.',
    ]
  }
  return []
}

export type PlacementInput = {
  placement: TunnelPlacement
  /** Servers that run the connector (`one`, `chosen`). */
  serverIds: string[]
  /** Servers left out of an `all` tunnel. */
  exceptServerIds: string[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function uuidList(value: unknown, field: string): Parsed<string[]> {
  if (value === undefined) return { ok: true, value: [] }
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    !value.every((v) => typeof v === 'string' && UUID_RE.test(v))
  ) {
    return { ok: false, field, detail: 'Must be a list of server ids' }
  }
  return { ok: true, value: [...new Set(value as string[])] }
}

/** Read the placement part of a create or update body and refuse mixed-up lists. */
export function parsePlacementBody(body: Record<string, unknown>): Parsed<PlacementInput> {
  const placement = TUNNEL_PLACEMENTS.find((p) => p === body.placement)
  if (!placement) {
    return {
      ok: false,
      field: 'placement',
      detail: `The placement must be ${TUNNEL_PLACEMENTS.join(', ')}`,
    }
  }
  const serverIds = uuidList(body.serverIds, 'serverIds')
  if (!serverIds.ok) return serverIds
  const exceptServerIds = uuidList(body.exceptServerIds, 'exceptServerIds')
  if (!exceptServerIds.ok) return exceptServerIds
  if (placement === 'one' && serverIds.value.length !== 1) {
    return { ok: false, field: 'serverIds', detail: 'Choose exactly one server' }
  }
  if (placement === 'chosen' && serverIds.value.length === 0) {
    return { ok: false, field: 'serverIds', detail: 'Choose at least one server' }
  }
  if (placement === 'all' && serverIds.value.length > 0) {
    return {
      ok: false,
      field: 'serverIds',
      detail: 'Servers are not chosen for an all-servers Tunnel',
    }
  }
  if (placement !== 'all' && exceptServerIds.value.length > 0) {
    return {
      ok: false,
      field: 'exceptServerIds',
      detail: 'Only an all-servers Tunnel leaves servers out',
    }
  }
  return {
    ok: true,
    value: { placement, serverIds: serverIds.value, exceptServerIds: exceptServerIds.value },
  }
}
