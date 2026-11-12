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

/**
 * For servers that run this Tunnel's sites on a daemon that cannot add a lock
 * to a site deployed before the hostname joined the Tunnel: that name is not
 * locked until the site is deployed again. Null when there are none.
 */
export function hostnameLockWarning(serverCount: number): string | null {
  if (serverCount === 0) return null
  const who =
    serverCount === 1
      ? '1 server that runs this Tunnel’s sites cannot lock'
      : `${serverCount} servers that run this Tunnel’s sites cannot lock`
  const fix = serverCount === 1 ? 'Update its daemon' : 'Update their daemons'
  return `${who} a hostname added to the Tunnel until the site is deployed again, so a site deployed before the hostname was added answers visitors directly. ${fix}, or redeploy those sites after adding the hostname.`
}

/**
 * For servers whose daemon can add a lock but skips a site with an automatic
 * certificate or with `forceHttps` off: a local-only hostname added to such a
 * site stays open until the site is deployed again. Null when there are none.
 */
export function hostnameLockSkippedWarning(serverCount: number): string | null {
  if (serverCount === 0) return null
  const who =
    serverCount === 1
      ? '1 server runs a site of this Tunnel that has'
      : `${serverCount} servers run sites of this Tunnel that have`
  return `${who} an automatic certificate or the HTTPS-only setting turned off. A hostname added to the Tunnel is locked on those sites only when the site is deployed again, and answers visitors directly until then. Redeploy those sites after adding the hostname.`
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

/**
 * What a placement change does to the portal rows: the servers whose row goes
 * (left out now, or switched between `run` and `skip`) and the rows to add. A
 * server that keeps the same role keeps its row, and with it what its
 * connector last reported, so the screen does not fall back to "not reported
 * yet" for a server the change did not touch. Pure.
 */
export function portalChanges(
  existing: readonly PortalFact[],
  wanted: readonly PortalFact[]
): { remove: string[]; add: PortalFact[] } {
  const want = new Map(wanted.map((p) => [p.serverId, p.wanted]))
  const have = new Map(existing.map((p) => [p.serverId, p.wanted]))
  return {
    remove: existing.filter((p) => want.get(p.serverId) !== p.wanted).map((p) => p.serverId),
    add: wanted.filter((p) => have.get(p.serverId) !== p.wanted),
  }
}
