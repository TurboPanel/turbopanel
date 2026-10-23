/**
 * Whole-host loss of an HA database primary: the pure decision rule.
 *
 * A powered-off host sends nothing, so none of the engine-level detectors
 * (Orchestrator, the Postgres probe) can see it. The control plane sees only
 * that the host's daemon connection went silent, which is also what a network
 * blip between the control plane and a healthy host looks like. This module
 * decides what the silence means; `ha-host-loss-sweep.ts` gathers the facts
 * and acts. Nothing here touches the database or the clock.
 *
 * The rule, in order. Anything short of a clear yes means "alert, do not
 * promote" (a row in the recovery journal with the reason in plain words):
 *
 * 1. The primary's server must have been marked offline for the whole window
 *    (default 2 min). Two kinds of mark count: `sweep_stale` (no heartbeat for
 *    90-150 s, a powered-off or cut-off host) and `disconnect` (the daemon's
 *    socket closed cleanly: the daemon was stopped or the host shut down). A
 *    `disconnect` alone could be a restart, so it gets no extra trust: the
 *    window, the planned-reboot grace and rule 6 (every other member must
 *    confirm the primary is gone) all apply to it exactly as to a stale mark.
 *    Back inside the window: nothing happens.
 * 2. Not while an operator reboot of that server or a daemon update is under
 *    way (the first 10 minutes), and not later than
 *    {@link hostLossLastDecisionMs} after the offline mark (the fresh-standby
 *    gate cannot tie a replica's last contact to the failure any later).
 * 3. Not during a fleet-wide outage: more than half of the organization's
 *    servers offline points at the control plane's own network, not one host.
 * 4. Only PostgreSQL, MySQL and MariaDB. A MySQL or MariaDB replica is
 *    proven caught up by its daemon's `fullyApplied` reading
 *    (`managed-replica-freshness-v1`); anything else alerts only.
 * 5. Only when the dead primary's daemon advertised `managed-ha-boot-hold-v1`,
 *    because that is what stops it serving writes when it returns.
 * 6. Every other member's server must be connected and must answer a fresh
 *    health read, and NONE may still be receiving from the primary. One
 *    replica that still hears the primary means the host is alive and only
 *    its link to the control plane is down.
 *
 * 7. The second signal: the other members' servers must each fail to open a
 *    connection to the primary's database port ({@link hostLossEngineVerdict}:
 *    two rounds {@link HOST_LOSS_ENGINE_PROBE_GAP_MS} apart, each attempt
 *    bounded to 3 s on the peer, refused / timeout / no route all count as
 *    "not reachable"). One connection that opens vetoes: a daemon that merely
 *    crashed or was stopped on a healthy host is never failed over. A check
 *    that did not run or answer is no confirmation either. A pure network
 *    partition (peers cannot reach the host, the host is fine) still looks the
 *    same; closing that needs a witness outside the cluster's network.
 *
 * Then, and only then, the ordinary automatic-failover gates apply
 * unchanged: the per-environment switch, the 15 minute cooldown, a healthy
 * same-datacenter failover replica proven caught up (the fresh-standby gate,
 * anchored on {@link hostLossFailureStartMs}), a command queue.
 */

import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import { MANAGED_HA_BOOT_HOLD_FEATURE } from '../../lib/version-wire.ts'
import { isMysqlFamilyEngine, MAX_FAILURE_SPAN_MS } from './ha-fresh-standby.ts'

/** PostgreSQL, MySQL and MariaDB can fail over after a lost server. */
function isHostLossEngine(engine: string): boolean {
  return engine === 'postgres' || isMysqlFamilyEngine(engine)
}

/** `metadata.detector` of a recovery row raised by this path. */
export const HOST_LOSS_DETECTOR = 'host-loss'

export const HOST_LOSS_WINDOW_ENV = 'TURBOPANEL_HOST_LOSS_WINDOW_SECONDS'
export const DEFAULT_HOST_LOSS_WINDOW_MS = 120_000
export const MIN_HOST_LOSS_WINDOW_MS = 60_000
export const MAX_HOST_LOSS_WINDOW_MS = 300_000

/**
 * The stale-sweep mark trails the real silence: the offline sweep declares a
 * server stale 90 s after its last answer and runs every 60 s, so the host
 * stopped answering at most this long before the mark. The fresh-standby gate
 * is anchored here (the earliest the host can have died).
 */
export const HOST_LOSS_MARK_LAG_MS = 150_000

/**
 * Why the primary's server was marked offline (`server.offline_reason`).
 * `sweep_stale`: no heartbeat (power loss, cut cable). `disconnect`: the
 * daemon's socket closed (daemon stopped, host shut down).
 */
export type HostLossMarkReason = 'sweep_stale' | 'disconnect'

/** The offline reasons the host-loss path acts on. */
export const HOST_LOSS_MARK_REASONS: readonly HostLossMarkReason[] = ['sweep_stale', 'disconnect']

/**
 * How far before the mark the host can have died. A closed socket is marked
 * the moment it closes (a few seconds at most), so the mark itself is the
 * anchor; only the stale sweep's mark trails the real silence.
 */
function markLagMs(reason: HostLossMarkReason): number {
  return reason === 'disconnect' ? 0 : HOST_LOSS_MARK_LAG_MS
}

/**
 * Slack for the peer-quiet check after a clean `disconnect`: the replicas lose
 * the stream within a few seconds of the daemon's socket closing, so when the
 * first tick after the window looks, their last contact is a hair younger than
 * the window. Without it that tick would alert "not confirmed" and the
 * promotion would wait a whole extra minute.
 */
export const HOST_LOSS_DISCONNECT_PEER_SLACK_MS = 15_000

/** Nothing is decided for a planned reboot / update for this long. */
export const HOST_LOSS_PLANNED_GRACE_MS = 600_000

/**
 * The latest, measured from the offline mark, that a promotion may still be
 * decided: the fresh-standby gate's failure span (`MAX_FAILURE_SPAN_MS`,
 * counted from {@link hostLossFailureStartMs}). The gate's own receipt check
 * does not depend on when the probe runs, so without this cap a retry long
 * after the loss would still pass it. Later than this: alert only.
 */
export function hostLossLastDecisionMs(reason: HostLossMarkReason = 'sweep_stale'): number {
  return MAX_FAILURE_SPAN_MS - markLagMs(reason)
}

/**
 * The stale-sweep mark's value of {@link hostLossLastDecisionMs}; a closed-socket
 * mark has no lag and may be decided {@link MAX_FAILURE_SPAN_MS} after the mark.
 * Use the function when the mark reason is known.
 */
export const HOST_LOSS_LAST_DECISION_MS = hostLossLastDecisionMs('sweep_stale')

/** A host offline this long is no longer an incident this path works on. */
export const HOST_LOSS_GIVE_UP_MS = 1_800_000

/** More than this share of the organization's servers offline is not one host. */
export const HOST_LOSS_FLEET_OUTAGE_SHARE = 0.5

/** `TURBOPANEL_HOST_LOSS_WINDOW_SECONDS`, clamped to 60-300 s; bad = default. */
export function resolveHostLossWindowMs(
  env: Readonly<Record<string, string | undefined>> | undefined
): number {
  const raw = env?.[HOST_LOSS_WINDOW_ENV]?.trim() ?? ''
  if (!/^\d{1,5}$/.test(raw)) return DEFAULT_HOST_LOSS_WINDOW_MS
  return Math.min(Math.max(Number(raw) * 1000, MIN_HOST_LOSS_WINDOW_MS), MAX_HOST_LOSS_WINDOW_MS)
}

/** One incident: this server, silent since this offline mark. */
export function hostLossIncidentKey(serverId: string, offlineSince: string): string {
  return `${serverId}@${offlineSince}`
}

/** Earliest the host can have died (control-plane ms). */
export function hostLossFailureStartMs(
  offlineSinceMs: number,
  reason: HostLossMarkReason = 'sweep_stale'
): number {
  return offlineSinceMs - markLagMs(reason)
}

export type HostLossAlertCode =
  | 'too_late'
  | 'fleet_outage'
  | 'engine_unsupported'
  | 'daemon_too_old'
  | 'not_corroborated'
  | 'peer_streaming'
  | 'engine_reachable'
  | 'engine_unconfirmed'

/** Plain-words journal text, one per code. */
export const HOST_LOSS_ALERT_MESSAGES: Readonly<Record<HostLossAlertCode, string>> = {
  too_late:
    "The primary's server has been silent for too long for an automatic failover to be safe (the replicas' last contact with it can no longer be tied to the moment it went down), so nothing was changed. If the server is really gone, promote a replica from the database page.",
  fleet_outage:
    "The primary's server stopped answering, but so did most of the other servers. That points at the control plane's network, not one lost host, so nothing was changed. Check the servers, then promote a replica by hand if the primary is really gone.",
  engine_unsupported:
    "The primary's server stopped answering. Automatic failover for a lost server is not available for this database engine, so nothing was changed. If the server is really gone, promote a replica from the database page.",
  daemon_too_old:
    "The primary's server stopped answering, and its daemon is too old to hold the database back when the server returns, so nothing was changed. If the server is really gone, promote a replica from the database page.",
  not_corroborated:
    "The primary's server stopped answering, but the other servers of this database could not confirm that the primary is down (one is offline or did not answer), so nothing was changed. If the server is really gone, promote a replica from the database page.",
  peer_streaming:
    "The primary's server stopped answering the control plane, but a replica still reports it is receiving data from the primary, so the host is probably alive and only its link to the control plane is down. Nothing was changed.",
  engine_reachable:
    "The primary's server stopped answering the control plane, but the other servers of this database can still open a connection to the primary's database port, so the database is probably still running and only the server's daemon is down. Nothing was changed.",
  engine_unconfirmed:
    "The primary's server stopped answering and its replicas are not receiving from it, but the other servers could not confirm that the primary's database port is unreachable (a check did not answer, or was not possible), so nothing was changed. If the server is really gone, promote a replica from the database page.",
}

export type HostLossPreflightFacts = {
  nowMs: number
  /** `server.status_changed_at` of the primary's server, ms. */
  offlineSinceMs: number
  windowMs: number
  /** Why the server was marked offline; absent = a stale-sweep mark. */
  markReason?: HostLossMarkReason
  engine: string
  /** Features the primary's daemon advertised when it last connected. */
  primaryDaemonFeatures: readonly string[]
  /** An operator reboot of the primary's server or a daemon update is recent. */
  plannedReboot: boolean
  /** Servers of the primary's organization: how many, how many offline. */
  orgServers: number
  orgServersOffline: number
  /** Another member of this cluster has a server that is not connected. */
  peerServerOffline: boolean
}

export type HostLossPreflight =
  | { action: 'wait'; reason: 'inside_window' | 'planned_reboot' }
  | { action: 'ignore' }
  | { action: 'alert'; code: HostLossAlertCode }
  | { action: 'probe' }

/** Steps 1-5 of the rule plus "every other server is connected": cheap, no probes. */
export function hostLossPreflight(facts: Readonly<HostLossPreflightFacts>): HostLossPreflight {
  // An unreadable offline mark proves nothing: never decide on it.
  if (!Number.isFinite(facts.offlineSinceMs) || !Number.isFinite(facts.nowMs)) {
    return { action: 'ignore' }
  }
  const offlineForMs = facts.nowMs - facts.offlineSinceMs
  if (offlineForMs < facts.windowMs) return { action: 'wait', reason: 'inside_window' }
  if (offlineForMs > HOST_LOSS_GIVE_UP_MS) return { action: 'ignore' }
  if (offlineForMs > hostLossLastDecisionMs(facts.markReason)) {
    return { action: 'alert', code: 'too_late' }
  }
  if (facts.plannedReboot && offlineForMs < HOST_LOSS_PLANNED_GRACE_MS) {
    return { action: 'wait', reason: 'planned_reboot' }
  }
  if (
    facts.orgServers > 0 &&
    facts.orgServersOffline / facts.orgServers > HOST_LOSS_FLEET_OUTAGE_SHARE
  ) {
    return { action: 'alert', code: 'fleet_outage' }
  }
  if (!isHostLossEngine(facts.engine)) return { action: 'alert', code: 'engine_unsupported' }
  if (!facts.primaryDaemonFeatures.includes(MANAGED_HA_BOOT_HOLD_FEATURE)) {
    return { action: 'alert', code: 'daemon_too_old' }
  }
  if (facts.peerServerOffline) return { action: 'alert', code: 'not_corroborated' }
  return { action: 'probe' }
}

export type PeerReading = 'still_receiving' | 'not_receiving' | 'no_answer'

/**
 * One other member's fresh health read. Only an answer that says the member is
 * NOT receiving from the primary AND has not been streaming for long enough
 * corroborates; `streaming` is the veto, flapping states cannot corroborate.
 *
 * P1-3: Require `lastStreaming.ageMs` > window (primary must be truly stale)
 * OR the member has been non-streaming for long enough via `notStreamingSince`.
 * Prevents flapping replicas (streaming then starting, repeating) from vetoing.
 */
export function readPeer(
  health: ManagedReplicationHealth | null,
  windowMs: number,
  slackMs = 0
): PeerReading {
  if (!health || typeof health.state !== 'string' || health.state.length === 0) return 'no_answer'
  if (health.state === 'streaming') return 'still_receiving'

  // Non-streaming: require proof the primary is actually stale, not a temporary flap.
  // P1-3: Check that last streaming was > window ago. The daemon measures ageMs on
  // its monotonic clock when building the health result. This prevents flapping
  // replicas (streaming, starting, streaming, ...) from vetoing a dead primary.
  const { lastStreaming } = health

  // If lastStreaming.ageMs is known and exceeds window, replica is caught up.
  if (typeof lastStreaming?.ageMs === 'number' && lastStreaming.ageMs > windowMs - slackMs) {
    return 'not_receiving'
  }

  // Not yet enough time since last streaming, or no streaming data: cannot corroborate yet.
  // Future enhancement (turbopaneld-side): track notStreamingSince timestamp to detect
  // persistent non-streaming without relying on lastStreaming.ageMs alone.
  return 'no_answer'
}

/** One peer's attempt to open a connection to the primary's database port. */
export type EngineReach = 'reachable' | 'unreachable' | 'unknown'

/** Rounds of engine-port checks, every peer in each, before a lost host is promoted over. */
export const HOST_LOSS_ENGINE_PROBE_ROUNDS = 2
/** Pause between two rounds; each connection attempt itself is cut off after 3 s on the peer. */
export const HOST_LOSS_ENGINE_PROBE_GAP_MS = 10_000

/**
 * What one connection attempt from a peer means. Only an attempt that was
 * actually made counts: a connection that opens is `reachable`; one that is
 * refused (host up, nothing listening), times out or finds no route is
 * `unreachable`. Anything else (no answer from the peer, an old daemon, a
 * target the peer refused to try) is `unknown` and never supports a promotion.
 */
export function classifyEngineReach(
  entry: { reachable: boolean; error?: string } | null | undefined
): EngineReach {
  if (!entry) return 'unknown'
  if (entry.reachable) return 'reachable'
  return entry.error === 'refused' || entry.error === 'timeout' || entry.error === 'unreachable'
    ? 'unreachable'
    : 'unknown'
}

/**
 * The second signal. `rounds` holds, per round, what every other member saw of
 * the primary's database port. Any open connection in any round vetoes (the
 * database is alive, only its daemon is gone). Promotion needs at least
 * {@link HOST_LOSS_ENGINE_PROBE_ROUNDS} complete rounds and every attempt in
 * them unreachable; a missing or unknown attempt never counts.
 */
export function hostLossEngineVerdict(
  rounds: readonly (readonly EngineReach[])[]
): HostLossVerdict {
  const all = rounds.flat()
  if (all.includes('reachable')) return { action: 'alert', code: 'engine_reachable' }
  if (
    rounds.length < HOST_LOSS_ENGINE_PROBE_ROUNDS ||
    rounds.some((round) => round.length === 0) ||
    all.includes('unknown')
  ) {
    return { action: 'alert', code: 'engine_unconfirmed' }
  }
  return { action: 'promote' }
}

export type HostLossVerdict =
  | {
      action: 'alert'
      code: 'peer_streaming' | 'not_corroborated' | 'engine_reachable' | 'engine_unconfirmed'
    }
  | { action: 'promote' }

/** Step 6: every other member must corroborate; any one that hears the primary vetoes. */
export function hostLossVerdict(peers: readonly PeerReading[]): HostLossVerdict {
  if (peers.length === 0) return { action: 'alert', code: 'not_corroborated' }
  if (peers.includes('still_receiving')) return { action: 'alert', code: 'peer_streaming' }
  if (peers.includes('no_answer')) return { action: 'alert', code: 'not_corroborated' }
  return { action: 'promote' }
}
