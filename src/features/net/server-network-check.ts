/**
 * Reachability check for "which network do servers use to talk to each other".
 *
 * Pure planning and summarising; the route (`client/datacenters/routes.ts`)
 * loads the pins and ssh ports, `client/datacenters/network-check-probe.ts`
 * asks each host. A host tries a TCP connection to every other member's pinned
 * address on that network, on the peer's ssh port. The port is only a way to
 * prove the path (route, source address, interface), not an application port.
 */

import type {
  ServerNetworkCheckEntry,
  ServerNetworkCheckTarget,
} from '../../contracts/cell-protocol.ts'
import { MAX_DAEMON_WS_NETWORK_CHECK_TARGETS } from '../../contracts/cell-protocol.ts'
import type { DatacenterMembershipRow } from './datacenter-membership.ts'

export type NetworkCheckMember = { serverId: string; address: string }

export type NetworkCheckPlanEntry = {
  serverId: string
  targets: ServerNetworkCheckTarget[]
}

/**
 * Per member: the other members' pinned addresses with their ssh ports. A
 * member alone in the network has nothing to check and is left out. Targets
 * are cut at the wire limit.
 */
export function planNetworkCheck(
  members: readonly NetworkCheckMember[],
  sshPortByServer: ReadonlyMap<string, number>
): NetworkCheckPlanEntry[] {
  const out: NetworkCheckPlanEntry[] = []
  for (const from of members) {
    const targets = members
      .filter((peer) => peer.serverId !== from.serverId)
      .map((peer) => ({
        peerServerId: peer.serverId,
        address: peer.address,
        port: sshPortByServer.get(peer.serverId) ?? 22,
      }))
      .slice(0, MAX_DAEMON_WS_NETWORK_CHECK_TARGETS)
    if (targets.length > 0) out.push({ serverId: from.serverId, targets })
  }
  return out
}

/** What one server's probe came back as. */
export type NetworkCheckServerOutcome =
  | { status: 'checked'; results: ServerNetworkCheckEntry[] }
  | { status: 'not_tested'; reason: 'daemon_update_required' | 'offline' | 'timeout' | 'error' }

export type NetworkCheckPeerResult = {
  peerServerId: string
  address: string
  port: number
  result: 'reachable' | 'not_reachable' | 'not_tested'
  latencyMs?: number
  sourceAddress?: string
  interface?: string
  /** `refused`, `timeout`, `unreachable`, `invalid_target`, or a `not_tested` reason. */
  reason?: string
}

export type NetworkCheckServerReport = {
  serverId: string
  status: 'checked' | 'not_tested'
  reason?: string
  peers: NetworkCheckPeerResult[]
}

export type NetworkCheckReport = {
  datacenterId: string
  servers: NetworkCheckServerReport[]
  /** Peers that did not answer. Saving is held back while this is above zero. */
  unreachableCount: number
  /** Peers that could not be tested (older host, offline). Never blocks saving. */
  notTestedCount: number
}

function peerResult(
  target: ServerNetworkCheckTarget,
  entry: ServerNetworkCheckEntry | undefined
): NetworkCheckPeerResult {
  const base = { peerServerId: target.peerServerId, address: target.address, port: target.port }
  if (!entry) return { ...base, result: 'not_tested', reason: 'no_answer' }
  if (!entry.reachable) {
    return { ...base, result: 'not_reachable', ...(entry.error ? { reason: entry.error } : {}) }
  }
  return {
    ...base,
    result: 'reachable',
    ...(entry.latencyMs !== undefined ? { latencyMs: entry.latencyMs } : {}),
    ...(entry.sourceAddress ? { sourceAddress: entry.sourceAddress } : {}),
    ...(entry.interface ? { interface: entry.interface } : {}),
  }
}

/** Join the plan with each host's answer into the report the screen shows. */
export function summarizeNetworkCheck(
  datacenterId: string,
  plan: readonly NetworkCheckPlanEntry[],
  outcomes: ReadonlyMap<string, NetworkCheckServerOutcome>
): NetworkCheckReport {
  const servers: NetworkCheckServerReport[] = plan.map((entry) => {
    const outcome = outcomes.get(entry.serverId)
    if (!outcome || outcome.status === 'not_tested') {
      return {
        serverId: entry.serverId,
        status: 'not_tested' as const,
        reason: outcome?.reason ?? 'error',
        peers: entry.targets.map((t) => ({
          peerServerId: t.peerServerId,
          address: t.address,
          port: t.port,
          result: 'not_tested' as const,
          reason: outcome?.reason ?? 'error',
        })),
      }
    }
    const byPeer = new Map(outcome.results.map((r) => [r.peerServerId, r]))
    return {
      serverId: entry.serverId,
      status: 'checked' as const,
      peers: entry.targets.map((t) => peerResult(t, byPeer.get(t.peerServerId))),
    }
  })
  const peers = servers.flatMap((s) => s.peers)
  return {
    datacenterId,
    servers,
    unreachableCount: peers.filter((p) => p.result === 'not_reachable').length,
    notTestedCount: peers.filter((p) => p.result === 'not_tested').length,
  }
}

/**
 * Shown when the network that currently carries server-to-server traffic has
 * a server whose link is down, so those servers already use the next shared
 * network. `reason` is `link_down` when a NIC reports no link, and
 * `unreachable` when every server that could still be asked failed to reach
 * the server over this network (the panel's own probes, see
 * `network-probe.ts`).
 */
export type ChosenNetworkDownWarning = {
  code: 'chosen_network_down'
  datacenterId: string
  /** The shared network traffic moves to; null when no other trusted network exists. */
  fallbackDatacenterId: string | null
  serverIds: string[]
  reason: 'link_down' | 'unreachable'
}

export type TrafficRival = { id: string; priority: number; trusted: boolean }

/** The trusted network every pair tries first: lowest number, then id. */
export function winningNetworkId(datacenters: readonly TrafficRival[]): string | null {
  const trusted = datacenters
    .filter((dc) => dc.trusted)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  return trusted[0]?.id ?? null
}

export function chosenNetworkDownWarnings(
  datacenters: readonly TrafficRival[],
  pins: readonly DatacenterMembershipRow[]
): ChosenNetworkDownWarning[] {
  const winner = winningNetworkId(datacenters)
  if (!winner) return []
  const downPins = pins.filter((p) => p.datacenterId === winner && p.linkDown)
  const serverIds = [...new Set(downPins.map((p) => p.serverId))].sort((a, b) => a.localeCompare(b))
  if (serverIds.length === 0) return []
  const reason = downPins.every((p) => p.probedDown) ? 'unreachable' : 'link_down'
  const fallback =
    datacenters
      .filter((dc) => dc.trusted && dc.id !== winner)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0]?.id ?? null
  return [
    {
      code: 'chosen_network_down',
      datacenterId: winner,
      fallbackDatacenterId: fallback,
      serverIds,
      reason,
    },
  ]
}
