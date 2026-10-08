/**
 * TurboPanel-owned HA candidate policy. Orchestrator discovers topology and
 * executes a designated recover; it must not pick the candidate.
 *
 * `readEligible` has zero effect on automatic promotion.
 */

import type { RecoveryKind } from './recovery.ts'
import {
  AUTOMATIC_FAILOVER_BLOCKED_MESSAGE,
  AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE,
  AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE,
} from './recovery.ts'

export const HA_PROMOTION_RULE_PREFER = 'prefer'
export const HA_PROMOTION_RULE_MUST_NOT = 'must_not'

export type HaPromotionRule = typeof HA_PROMOTION_RULE_PREFER | typeof HA_PROMOTION_RULE_MUST_NOT

export type HaMemberCandidateInput = {
  id: string
  role: string
  replicaClass: string | null
  ordinal: number
  sameDatacenterAsPrimary: boolean
  /** Streaming, fresh, and under the promote lag threshold. */
  healthy: boolean
}

/**
 * Same-DC `failover` class, ignoring health. Used to distinguish "none
 * exist" from "none are healthy enough" when blocking automatic failover.
 */
export function isAutomaticFailoverClassMember(member: Readonly<HaMemberCandidateInput>): boolean {
  return (
    member.role === 'replica' &&
    member.replicaClass === 'failover' &&
    member.sameDatacenterAsPrimary
  )
}

/**
 * Same-DC `failover` replicas may auto-promote when healthy. `read` replicas
 * never do. Cross-datacenter is disaster recovery only (operator route).
 * `readEligible` has zero effect.
 */
export function isAutomaticFailoverCandidate(member: Readonly<HaMemberCandidateInput>): boolean {
  return isAutomaticFailoverClassMember(member) && member.healthy
}

/**
 * Deterministic pick: lowest ordinal among automatic candidates.
 * `readEligible` is ignored.
 */
export function pickAutomaticFailoverCandidate(
  members: readonly HaMemberCandidateInput[]
): HaMemberCandidateInput | null {
  const eligible = members
    .filter((member) => isAutomaticFailoverCandidate(member))
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
  return eligible[0] ?? null
}

/**
 * Why automatic failover cannot pick a candidate. `null` when a pick exists.
 */
export function automaticFailoverBlockCause(
  members: readonly HaMemberCandidateInput[]
): 'no-candidate' | 'unhealthy' | null {
  if (pickAutomaticFailoverCandidate(members)) return null
  return members.some((member) => isAutomaticFailoverClassMember(member))
    ? 'unhealthy'
    : 'no-candidate'
}

export function orchestratorPromotionRule(replicaClass: string | null): HaPromotionRule {
  return replicaClass === 'failover' ? HA_PROMOTION_RULE_PREFER : HA_PROMOTION_RULE_MUST_NOT
}

/**
 * Engines the bundled Orchestrator can run. It speaks the MySQL protocol
 * only: a Postgres member answers `/api/discover` with HTTP 500 `invalid
 * connection`, and Postgres HA is not Orchestrator's to manage at all. A
 * Postgres cluster is therefore left out of `managed.ha.reconcile` entirely
 * rather than registered and skipped daemon-side.
 */
export function orchestratorManagesEngine(engine: string): boolean {
  return engine === 'mysql' || engine === 'mariadb'
}

/**
 * Automatic failover must not continue when the old primary cannot be fenced.
 * Operator switchover and disaster recovery may continue (`needs_resync`).
 */
export function shouldBlockUnreachablePrimaryFence(kind: RecoveryKind): boolean {
  return kind === 'automatic-failover'
}

export function automaticFailoverBlockedReason(
  cause: 'unfenced' | 'no-candidate' | 'unhealthy'
): string {
  if (cause === 'no-candidate') return AUTOMATIC_FAILOVER_NO_CANDIDATE_MESSAGE
  if (cause === 'unhealthy') return AUTOMATIC_FAILOVER_UNHEALTHY_MESSAGE
  return AUTOMATIC_FAILOVER_BLOCKED_MESSAGE
}

/**
 * After disaster recovery, members that no longer share a datacenter with the
 * new primary cannot stay `failover`. Same-DC `read` peers are never silently
 * upgraded.
 */
export function replicaClassAfterDisasterRecovery(input: {
  role: string
  replicaClass: string | null
  sameDatacenterAsNewPrimary: boolean
}): 'failover' | 'read' | null {
  if (input.role === 'primary') return null
  if (input.replicaClass === 'failover' && !input.sameDatacenterAsNewPrimary) {
    return 'read'
  }
  if (input.replicaClass === 'failover' || input.replicaClass === 'read') {
    return input.replicaClass
  }
  return 'read'
}

/** Primary and same-DC failover replicas join the org Orchestrator Raft group. */
export function serverHostsManagedHa(
  membersOnServer: ReadonlyArray<{ role: string; replicaClass: string | null }>
): boolean {
  return membersOnServer.some(
    (member) => member.role === 'primary' || member.replicaClass === 'failover'
  )
}

/**
 * One address out of a server's pins in one datacenter: IPv4 first, then a
 * fixed textual order within a family, so the answer never depends on the
 * order the database returned the rows in.
 */
export function pickHaAdvertiseAddress(
  pins: ReadonlyArray<{ address: string; family: 4 | 6 }>
): string | null {
  const ordered = pins.toSorted((a, b) => a.family - b.family || a.address.localeCompare(b.address))
  return ordered[0]?.address ?? null
}

export type HaRaftPin = { datacenterId: string; address: string; family: 4 | 6 }

/** The routing policy fields Raft placement reads (see `DatacenterPolicyRow`). */
export type HaDatacenterPolicy = { priority: number; trusted: boolean }

/**
 * A datacenter with no policy entry: the documented defaults
 * (`DEFAULT_DATACENTER_PRIORITY` / `DEFAULT_DATACENTER_TRUSTED` in
 * datacenter-options.ts; not imported here, this module is loaded by the
 * command contracts). `loadDatacenterPolicies` seeds every id anyway.
 */
export const HA_DEFAULT_DATACENTER_POLICY: Readonly<HaDatacenterPolicy> = {
  priority: 100,
  trusted: true,
}

/**
 * Which datacenter each Raft server's traffic uses. Every server computes this
 * from the same inputs (all Raft servers' pins and the datacenter policies),
 * so all of them agree on who is in which group: a server never lists a voter
 * that does not list it back.
 *
 * Only trusted datacenters count, in `(priority asc, id asc)` order like the
 * private-endpoint ladder. A server joins the first of its datacenters that
 * at least one other Raft server is also pinned in; with none, its own best
 * trusted datacenter (a group of one, as for a server alone in its
 * datacenter). A server with only untrusted datacenters gets none.
 */
export function assignHaRaftDatacenters(
  raftServerIds: readonly string[],
  pins: ReadonlyMap<string, readonly HaRaftPin[]>,
  policies: ReadonlyMap<string, HaDatacenterPolicy>
): Map<string, string> {
  const policyOf = (id: string): HaDatacenterPolicy =>
    policies.get(id) ?? HA_DEFAULT_DATACENTER_POLICY
  const serversIn = new Map<string, Set<string>>()
  for (const serverId of raftServerIds) {
    for (const pin of pins.get(serverId) ?? []) {
      const members = serversIn.get(pin.datacenterId) ?? new Set<string>()
      members.add(serverId)
      serversIn.set(pin.datacenterId, members)
    }
  }
  const assignment = new Map<string, string>()
  for (const serverId of raftServerIds) {
    const ranked = [...new Set((pins.get(serverId) ?? []).map((pin) => pin.datacenterId))]
      .filter((id) => policyOf(id).trusted)
      .toSorted((a, b) => policyOf(a).priority - policyOf(b).priority || a.localeCompare(b))
    const shared = ranked.find((id) => (serversIn.get(id)?.size ?? 0) > 1)
    const chosen = shared ?? ranked[0]
    if (chosen) assignment.set(serverId, chosen)
  }
  return assignment
}

export type HaRaftMembers = {
  advertiseAddress: string
  peers: Array<{ serverId: string; address: string }>
}

/**
 * Raft voters for `thisServerId`: the HA servers assigned to the same
 * datacenter ({@link assignHaRaftDatacenters}). An org-wide group spanning
 * datacenters whose private networks cannot see each other never reaches
 * quorum (no leader, so no DeadPrimary and no automatic failover anywhere in
 * the org), and automatic failover is same-datacenter only, so a
 * cross-datacenter voter adds nothing but quorum risk.
 */
export function selectHaRaftMembers(
  thisServerId: string,
  raftServerIds: readonly string[],
  pins: ReadonlyMap<string, readonly HaRaftPin[]>,
  policies: ReadonlyMap<string, HaDatacenterPolicy> = new Map()
): HaRaftMembers | null {
  const ids = raftServerIds.includes(thisServerId)
    ? raftServerIds
    : [...raftServerIds, thisServerId]
  const assignment = assignHaRaftDatacenters(ids, pins, policies)
  const datacenterId = assignment.get(thisServerId)
  if (!datacenterId) return null
  const pinIn = (serverId: string): string | null =>
    pickHaAdvertiseAddress(
      (pins.get(serverId) ?? []).filter((pin) => pin.datacenterId === datacenterId)
    )
  const advertiseAddress = pinIn(thisServerId)
  if (!advertiseAddress) return null
  const peers: HaRaftMembers['peers'] = []
  for (const serverId of raftServerIds) {
    if (assignment.get(serverId) !== datacenterId) continue
    const address = pinIn(serverId)
    if (address) peers.push({ serverId, address })
  }
  return { advertiseAddress, peers }
}

/** `managed-ha-event` without `detector`: the daemon's Orchestrator poller. */
export const ORCHESTRATOR_DETECTOR = 'orchestrator'
/** The daemon's own Postgres probe on the primary's host. */
export const POSTGRES_PROBE_DETECTOR = 'postgres-probe'

/**
 * Detectors whose `managed-ha-event` may start automatic failover, and the
 * engines each may speak for. This is the policy switch for what counts as a
 * dead primary:
 *
 * - `orchestrator` (event without `detector`): Orchestrator DeadPrimary.
 *   MySQL/MariaDB only: Orchestrator's image has only the MySQL driver and
 *   never sees Postgres, so an Orchestrator-shaped event for Postgres is
 *   always spurious.
 * - `postgres-probe`: the Postgres engine is dead while its host and daemon
 *   are alive, so the old primary can still be fenced.
 *
 * Whole-host loss is deliberately absent: nothing can fence a host that is
 * gone, so it stays a manual operator action with an alert. Widening to it
 * (Option A) means adding a host-loss detector here once fencing can cope,
 * not changing the daemon probe.
 */
export const AUTOMATIC_FAILOVER_DETECTORS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  [ORCHESTRATOR_DETECTOR, ['mysql', 'mariadb']],
  [POSTGRES_PROBE_DETECTOR, ['postgres']],
])

/**
 * Detectors that run on the primary's own host. Their event must name the
 * current primary member and come from that member's server, so a stale
 * daemon (e.g. the old primary's host after a switchover) can never fail
 * over the new primary.
 */
export const PRIMARY_HOST_DETECTORS: ReadonlySet<string> = new Set([POSTGRES_PROBE_DETECTOR])

/** Minimum time between two accepted automatic failovers of one cluster. */
export const AUTOMATIC_FAILOVER_COOLDOWN_MS = 15 * 60_000

export type HaEventGateInput = {
  detector: string | undefined
  engine: string
  sourceMemberId?: string
  /** The authenticated session's server id, never a payload field. */
  reporterServerId: string
  /** Organization of the reporting server (`server.organization_id`). */
  reporterOrganizationId: string | null
  /** Organization that owns the cluster (its environment's project). */
  clusterOrganizationId: string | null
  /** Server ids hosting a member of the cluster. */
  memberServerIds: readonly string[]
  primary: { id: string; serverId: string } | null
}

function reporterRejection(input: HaEventGateInput): string | null {
  if (!input.memberServerIds.includes(input.reporterServerId)) {
    return 'reporting server hosts no member of this cluster'
  }
  if (
    input.clusterOrganizationId === null ||
    input.reporterOrganizationId !== input.clusterOrganizationId
  ) {
    return "reporting server is not in the cluster's organization"
  }
  return null
}

function primaryHostRejection(input: HaEventGateInput): string | null {
  if (!input.primary) return 'no current primary'
  if (input.sourceMemberId !== input.primary.id) {
    return 'event does not name the current primary'
  }
  if (input.reporterServerId !== input.primary.serverId) {
    return "event did not come from the current primary's server"
  }
  return null
}

/**
 * Why a `managed-ha-event` must not start automatic failover; `null` when it
 * may. Every detector (including none) must come from a server that hosts a
 * member of the cluster in the cluster's organization.
 */
export function haEventRejection(input: HaEventGateInput): string | null {
  const detector = input.detector ?? ORCHESTRATOR_DETECTOR
  const engines = AUTOMATIC_FAILOVER_DETECTORS.get(detector)
  if (!engines) return `detector ${detector} may not start automatic failover`
  if (!engines.includes(input.engine)) {
    return `detector ${detector} does not cover engine ${input.engine}`
  }
  const reporter = reporterRejection(input)
  if (reporter) return reporter
  return PRIMARY_HOST_DETECTORS.has(detector) ? primaryHostRejection(input) : null
}

export type OrchestratorBindingInput = {
  /** The reporting daemon lists `managed-ha-instance-v1`. */
  reporterBindsInstance: boolean
  instanceHost?: string
  instancePort?: number
  /**
   * The current primary's address as that reporter's Orchestrator knows it
   * (`null` = no primary, or no usable address for it).
   */
  expectedPrimary: { host: string; port: number } | null
}

/**
 * Why an Orchestrator dead-primary report is STALE (it does not name the
 * current primary, so it must never fence); `null` when it may proceed.
 * A daemon that does not list `managed-ha-instance-v1` sends no instance and
 * keeps the legacy behavior; one that lists it must send the instance.
 */
export function orchestratorBindingRejection(input: OrchestratorBindingInput): string | null {
  const named = input.instanceHost !== undefined && input.instancePort !== undefined
  if (!named) {
    return input.reporterBindsInstance
      ? 'report names no instance although the daemon advertises managed-ha-instance-v1'
      : null
  }
  if (!input.expectedPrimary) return 'the current primary has no known private address and port'
  const sameHost = input.instanceHost?.toLowerCase() === input.expectedPrimary.host.toLowerCase()
  if (sameHost && input.instancePort === input.expectedPrimary.port) return null
  return `reported instance ${input.instanceHost}:${input.instancePort} is not the current primary (${input.expectedPrimary.host}:${input.expectedPrimary.port})`
}

/** True while the last accepted automatic failover is inside the cooldown. */
export function automaticFailoverCoolingDown(
  lastAcceptedStartedAt: string | null,
  nowMs: number,
  cooldownMs: number = AUTOMATIC_FAILOVER_COOLDOWN_MS
): boolean {
  if (!lastAcceptedStartedAt) return false
  const started = Date.parse(lastAcceptedStartedAt)
  if (!Number.isFinite(started)) return false
  return nowMs - started < cooldownMs
}
