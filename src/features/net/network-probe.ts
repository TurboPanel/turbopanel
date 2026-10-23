/**
 * Automatic fallback when the chosen server-to-server network stops working.
 *
 * A network card that loses its cable is not always reported (and a switch or
 * firewall can cut a network with the link still up), so the panel also asks
 * the servers themselves: every minute or so it runs the reachability check
 * (`server-network-check.ts`) on the network that carries the traffic. A
 * server that nobody can reach on that network, and that cannot reach anybody
 * either, for {@link PROBE_FAILURES_TO_MARK_DOWN} rounds in a row is marked
 * (`ip.metadata.unreachable.downSince`); routing then treats the pin like a
 * pin whose link is down and uses the next shared network, and the warning
 * `chosen_network_down` says so. {@link PROBE_OKS_TO_CLEAR} good rounds clear
 * the mark. Pure decisions only; `client/datacenters/network-probe-sweep.ts`
 * does the database and host round trips.
 */

import type { NetworkCheckReport } from './server-network-check.ts'
import { type IpPinUnreachableMetadata, parseUnreachableMarker } from './pin-link-state.ts'

/** Rounds in a row without any answer before a server's network is marked down. */
export const PROBE_FAILURES_TO_MARK_DOWN = 3
/** Rounds in a row with an answer before the mark is removed again. */
export const PROBE_OKS_TO_CLEAR = 2

export type ProbeVerdict = 'ok' | 'fail' | 'unknown'

/**
 * Per server: `ok` when anything involving it got through (it reached a peer,
 * or a peer reached it), `fail` when everything involving it was tried and
 * nothing got through, `unknown` otherwise (a host that could not be asked, an
 * offline server) so that a server that is simply off is never blamed on the
 * network.
 */
export function probeVerdicts(report: NetworkCheckReport): Map<string, ProbeVerdict> {
  const involving = new Map<string, Array<'reachable' | 'not_reachable' | 'not_tested'>>()
  const add = (serverId: string, result: 'reachable' | 'not_reachable' | 'not_tested') => {
    involving.set(serverId, [...(involving.get(serverId) ?? []), result])
  }
  for (const server of report.servers) {
    if (!involving.has(server.serverId)) involving.set(server.serverId, [])
    for (const peer of server.peers) {
      add(server.serverId, peer.result)
      add(peer.peerServerId, peer.result)
    }
  }
  const out = new Map<string, ProbeVerdict>()
  for (const [serverId, results] of involving) {
    if (results.includes('reachable')) out.set(serverId, 'ok')
    else if (results.length === 0 || results.includes('not_tested')) out.set(serverId, 'unknown')
    else out.set(serverId, 'fail')
  }
  return out
}

export type ProbeTransition = {
  /** The marker to store; `null` removes it. */
  marker: IpPinUnreachableMetadata | null
  /** Whether the stored value differs from what is there now. */
  write: boolean
  /** `down` / `up` change what routing does, so they need the routing re-plan. */
  change: 'none' | 'down' | 'up'
}

const UNCHANGED = (marker: IpPinUnreachableMetadata | undefined): ProbeTransition => ({
  marker: marker ?? null,
  write: false,
  change: 'none',
})

/**
 * One probe round for one pin. A network that never answered (no `firstOkAt`)
 * is never marked: a port that is simply closed there must not move traffic.
 */
export function nextProbeMarker(
  previous: IpPinUnreachableMetadata | undefined,
  verdict: ProbeVerdict,
  nowIso: string
): ProbeTransition {
  if (verdict === 'unknown') return UNCHANGED(previous)
  const isDown = previous?.downSince !== undefined
  if (verdict === 'ok') {
    if (!previous) {
      return {
        marker: { failures: 0, okStreak: 0, firstOkAt: nowIso },
        write: true,
        change: 'none',
      }
    }
    const firstOkAt = previous.firstOkAt ?? nowIso
    if (!isDown) {
      if (previous.failures === 0 && previous.okStreak === 0 && previous.firstOkAt) {
        return UNCHANGED(previous)
      }
      return { marker: { failures: 0, okStreak: 0, firstOkAt }, write: true, change: 'none' }
    }
    const okStreak = previous.okStreak + 1
    if (okStreak >= PROBE_OKS_TO_CLEAR) {
      return { marker: { failures: 0, okStreak: 0, firstOkAt }, write: true, change: 'up' }
    }
    return {
      marker: { ...previous, firstOkAt, okStreak },
      write: true,
      change: 'none',
    }
  }
  // fail
  if (!previous?.firstOkAt) return UNCHANGED(previous)
  if (isDown) {
    if (previous.okStreak === 0) return UNCHANGED(previous)
    return { marker: { ...previous, okStreak: 0 }, write: true, change: 'none' }
  }
  const failures = previous.failures + 1
  if (failures >= PROBE_FAILURES_TO_MARK_DOWN) {
    return {
      marker: { failures, okStreak: 0, firstOkAt: previous.firstOkAt, downSince: nowIso },
      write: true,
      change: 'down',
    }
  }
  return {
    marker: { failures, okStreak: 0, firstOkAt: previous.firstOkAt },
    write: true,
    change: 'none',
  }
}

/** `ip.metadata` with the probe marker set (or removed for `null`), other keys kept. */
export function withProbeMarker(
  existing: unknown,
  marker: IpPinUnreachableMetadata | null
): Record<string, unknown> {
  const next: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  if (marker) next.unreachable = marker
  else delete next.unreachable
  return next
}

/** The stored probe marker of a pin's metadata. */
export function probeMarkerOf(metadata: unknown): IpPinUnreachableMetadata | undefined {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return undefined
  }
  return parseUnreachableMarker((metadata as Record<string, unknown>).unreachable)
}
