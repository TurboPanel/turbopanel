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
 *    (default 2 min, on top of the 90-150 s the offline sweep needs to notice).
 *    Back inside the window: nothing happens.
 * 2. Not while an operator reboot of that server or a daemon update is under
 *    way (the first 10 minutes), and not later than 7.5 minutes after the
 *    offline mark ({@link HOST_LOSS_LAST_DECISION_MS}: the fresh-standby gate
 *    cannot tie a replica's last contact to the failure any later).
 * 3. Not during a fleet-wide outage: more than half of the organization's
 *    servers offline points at the control plane's own network, not one host.
 * 4. Only PostgreSQL. MySQL and MariaDB replicas read "reconnecting" once the
 *    source is gone and cannot be proven caught up, so they alert only.
 * 5. Only when the dead primary's daemon advertised `managed-ha-boot-hold-v1`,
 *    because that is what stops it serving writes when it returns.
 * 6. Every other member's server must be connected and must answer a fresh
 *    health read, and NONE may still be receiving from the primary. One
 *    replica that still hears the primary means the host is alive and only
 *    its link to the control plane is down.
 *
 * Then, and only then, the ordinary automatic-failover gates apply
 * unchanged: the per-environment switch, the 15 minute cooldown, a healthy
 * same-datacenter failover replica proven caught up (the fresh-standby gate,
 * anchored on {@link hostLossFailureStartMs}), a command queue.
 */

import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import { MANAGED_HA_BOOT_HOLD_FEATURE } from '../../lib/version-wire.ts'
import { MAX_FAILURE_SPAN_MS } from './ha-fresh-standby.ts'

/** `metadata.detector` of a recovery row raised by this path. */
export const HOST_LOSS_DETECTOR = 'host-loss'

export const HOST_LOSS_WINDOW_ENV = 'TURBOPANEL_HOST_LOSS_WINDOW_SECONDS'
export const DEFAULT_HOST_LOSS_WINDOW_MS = 120_000
export const MIN_HOST_LOSS_WINDOW_MS = 60_000
export const MAX_HOST_LOSS_WINDOW_MS = 300_000

/**
 * The offline mark trails the real silence: the offline sweep declares a server
 * stale 90 s after its last answer and runs every 60 s, so the host stopped
 * answering at most this long before the mark. The fresh-standby gate is
 * anchored here (the earliest the host can have died).
 */
export const HOST_LOSS_MARK_LAG_MS = 150_000

/** Nothing is decided for a planned reboot / update for this long. */
export const HOST_LOSS_PLANNED_GRACE_MS = 600_000

/**
 * The latest, measured from the offline mark, that a promotion may still be
 * decided: the fresh-standby gate's failure span (`MAX_FAILURE_SPAN_MS`, 10
 * min, counted from {@link hostLossFailureStartMs}). The gate's own receipt
 * check does not depend on when the probe runs, so without this cap a retry
 * long after the loss would still pass it. Later than this: alert only.
 */
export const HOST_LOSS_LAST_DECISION_MS = MAX_FAILURE_SPAN_MS - HOST_LOSS_MARK_LAG_MS

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
export function hostLossFailureStartMs(offlineSinceMs: number): number {
  return offlineSinceMs - HOST_LOSS_MARK_LAG_MS
}

export type HostLossAlertCode =
  | 'too_late'
  | 'fleet_outage'
  | 'engine_unsupported'
  | 'daemon_too_old'
  | 'not_corroborated'
  | 'peer_streaming'

/** Plain-words journal text, one per code. */
export const HOST_LOSS_ALERT_MESSAGES: Readonly<Record<HostLossAlertCode, string>> = {
  too_late:
    "The primary's server has been silent for too long for an automatic failover to be safe (the replicas' last contact with it can no longer be tied to the moment it went down), so nothing was changed. If the server is really gone, promote a replica from the database page.",
  fleet_outage:
    "The primary's server stopped answering, but so did most of the other servers. That points at the control plane's network, not one lost host, so nothing was changed. Check the servers, then promote a replica by hand if the primary is really gone.",
  engine_unsupported:
    "The primary's server stopped answering. Automatic failover for a lost server is only available for PostgreSQL, so nothing was changed. If the server is really gone, promote a replica from the database page.",
  daemon_too_old:
    "The primary's server stopped answering, and its daemon is too old to hold the database back when the server returns, so nothing was changed. If the server is really gone, promote a replica from the database page.",
  not_corroborated:
    "The primary's server stopped answering, but the other servers of this database could not confirm that the primary is down (one is offline or did not answer), so nothing was changed. If the server is really gone, promote a replica from the database page.",
  peer_streaming:
    "The primary's server stopped answering the control plane, but a replica still reports it is receiving data from the primary, so the host is probably alive and only its link to the control plane is down. Nothing was changed.",
}

export type HostLossPreflightFacts = {
  nowMs: number
  /** `server.status_changed_at` of the primary's server, ms. */
  offlineSinceMs: number
  windowMs: number
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
  if (offlineForMs > HOST_LOSS_LAST_DECISION_MS) return { action: 'alert', code: 'too_late' }
  if (facts.plannedReboot && offlineForMs < HOST_LOSS_PLANNED_GRACE_MS) {
    return { action: 'wait', reason: 'planned_reboot' }
  }
  if (
    facts.orgServers > 0 &&
    facts.orgServersOffline / facts.orgServers > HOST_LOSS_FLEET_OUTAGE_SHARE
  ) {
    return { action: 'alert', code: 'fleet_outage' }
  }
  if (facts.engine !== 'postgres') return { action: 'alert', code: 'engine_unsupported' }
  if (!facts.primaryDaemonFeatures.includes(MANAGED_HA_BOOT_HOLD_FEATURE)) {
    return { action: 'alert', code: 'daemon_too_old' }
  }
  if (facts.peerServerOffline) return { action: 'alert', code: 'not_corroborated' }
  return { action: 'probe' }
}

export type PeerReading = 'still_receiving' | 'not_receiving' | 'no_answer'

/**
 * One other member's fresh health read. Only an answer that says the member is
 * NOT receiving from the primary corroborates; `streaming` is the veto, and
 * anything else (no answer, an unreadable reply) cannot corroborate.
 */
export function readPeer(health: ManagedReplicationHealth | null): PeerReading {
  if (!health || typeof health.state !== 'string' || health.state.length === 0) return 'no_answer'
  return health.state === 'streaming' ? 'still_receiving' : 'not_receiving'
}

export type HostLossVerdict =
  { action: 'alert'; code: 'peer_streaming' | 'not_corroborated' } | { action: 'promote' }

/** Step 6: every other member must corroborate; any one that hears the primary vetoes. */
export function hostLossVerdict(peers: readonly PeerReading[]): HostLossVerdict {
  if (peers.length === 0) return { action: 'alert', code: 'not_corroborated' }
  if (peers.includes('still_receiving')) return { action: 'alert', code: 'peer_streaming' }
  if (peers.includes('no_answer')) return { action: 'alert', code: 'not_corroborated' }
  return { action: 'promote' }
}
