/**
 * The outside reachability check: read what a server's ports should be,
 * dial them from the control plane, and say what happened.
 *
 * What it will connect to, and what it never will:
 *
 * - ONLY addresses the control plane already stores for that server (`ip`
 *   rows of the server's own organization), at most {@link MAX_PROBE_ADDRESSES}
 *   of them; the caller supplies no host or port. {@link observeOutside} takes
 *   a {@link ProbePlan} and builds its own targets, then re-checks each one.
 * - ONLY the planned ports ({@link planProbePorts}): sshd, the panel's own port
 *   on its host, and public tcp ports the derived ruleset opens.
 * - NEVER an address {@link mayProbeAddress} forbids (loopback, link-local and
 *   cloud-metadata, multicast, reserved ...), and private networks only when
 *   the platform says it can sit on them.
 * - Bounded: {@link PROBE_CONCURRENCY} connections at once, one handshake each
 *   of at most {@link PROBE_TIMEOUT_MS}, {@link MAX_PROBE_TARGETS} in a round.
 *   Nothing is written to or read from a connection, and only
 *   open/refused/timeout/blocked/error and a handshake time are kept.
 *
 * Nothing here applies or confirms a firewall change by itself:
 * {@link decideAfterApply} only returns a decision for the caller (stage 7) to
 * act on. Until `FIREWALL_APPLY_ENABLED` is flipped the only caller is the
 * owner/manager "check now" route.
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { bulwark } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { TcpProbe } from '../../platform/ports/tcp-probe.ts'
import { loadFirewallFacts } from './facts.ts'
import { mayProbeAddress } from './probe-address.ts'
import {
  type ConfirmationDecision,
  decideConfirmation,
  type PortReach,
  type ProbeObservation,
  reachFromObservations,
} from './probe-decision.ts'
import { type ProbePort, planProbePorts } from './probe-plan.ts'

export const PROBE_TIMEOUT_MS = 3_000
export const PROBE_CONCURRENCY = 4
export const MAX_PROBE_ADDRESSES = 4
export const MAX_PROBE_TARGETS = 24
/** "Check now" for one server at most this often. */
export const PROBE_MIN_INTERVAL_MS = 30_000
/** Stop a confirmation check this long before the host's own deadline, so a confirm still arrives in time. */
export const PROBE_CONFIRM_MARGIN_MS = 20_000
const PROBE_POLL_INTERVAL_MS = 4_000

/** What to check on one server: its stored addresses and the ports that matter. */
export type ProbePlan = {
  serverId: string
  organizationId: string
  addresses: string[]
  ports: ProbePort[]
  notes: string[]
}

export type OutsideProbeRecord = {
  at: string
  phase: 'manual' | 'baseline' | 'after'
  status: 'running' | 'done'
  ports: PortReach[]
  notes: string[]
  decision?: ConfirmationDecision
}

/** The plan for one server, or null when it has no organization or is gone. */
export async function loadProbePlan(db: Db, serverId: string): Promise<ProbePlan | null> {
  const facts = await loadFirewallFacts(db, serverId)
  if (!facts) return null
  const rows = await db.execute<{ address: string }>(sql`
    SELECT host(address) AS address
    FROM ip
    WHERE server_id = ${serverId}::uuid AND organization_id = ${facts.organizationId}::uuid
    ORDER BY (scope = 'public') DESC, address
  `)
  const plan = planProbePorts(facts.input)
  return {
    serverId,
    organizationId: facts.organizationId,
    addresses: [...rows].map((row) => row.address),
    ports: plan.ports,
    notes: plan.notes,
  }
}

type Target = { address: string; port: number }

function buildTargets(plan: ProbePlan, canReachPrivate: boolean, notes: string[]): Target[] {
  const usable: string[] = []
  for (const address of plan.addresses) {
    if (usable.length >= MAX_PROBE_ADDRESSES) break
    if (mayProbeAddress(address, canReachPrivate)) usable.push(address)
    else notes.push(`${address} is not checked from this control plane (private or not dialable)`)
  }
  if (usable.length === 0) notes.push('This server has no address the control plane can check')
  return usable
    .flatMap((address) => plan.ports.map((port) => ({ address, port: port.port })))
    .slice(0, MAX_PROBE_TARGETS)
}

/** The last line of defence: a target must be one of the plan's own addresses and ports. */
function isPlannedTarget(plan: ProbePlan, target: Target, canReachPrivate: boolean): boolean {
  return (
    plan.addresses.includes(target.address) &&
    plan.ports.some((port) => port.port === target.port) &&
    mayProbeAddress(target.address, canReachPrivate)
  )
}

async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  step: (item: T) => Promise<R>
): Promise<R[]> {
  const lanes: { item: T; index: number }[][] = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => []
  )
  items.forEach((item, index) => lanes[index % lanes.length]!.push({ item, index }))
  const results = new Array<R>(items.length)
  await Promise.all(
    lanes.map((lane) =>
      forEachSequential(lane, async ({ item, index }) => {
        results[index] = await step(item)
      })
    )
  )
  return results
}

export type OutsideRound = {
  observations: ProbeObservation[]
  reach: PortReach[]
  notes: string[]
}

/** One round of attempts over the plan's targets, bounded as described above. */
export async function observeOutside(
  probe: TcpProbe,
  plan: ProbePlan,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<OutsideRound> {
  const notes = [...plan.notes]
  const targets = buildTargets(plan, probe.canReachPrivate, notes).filter((target) =>
    isPlannedTarget(plan, target, probe.canReachPrivate)
  )
  const observations = await runBounded(targets, PROBE_CONCURRENCY, async (target) => {
    const result = await probe.connect(target, timeoutMs)
    return { address: target.address, port: target.port, state: result.state, ms: result.ms }
  })
  return { observations, reach: reachFromObservations(plan.ports, observations), notes }
}

type AfterApplyDeps = {
  baseline: readonly PortReach[]
  /** One more round after the new ruleset is loaded. */
  observe: () => Promise<readonly PortReach[]>
  /** Epoch milliseconds after which no further round starts. */
  deadlineMs: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** When to stop checking: the host's own confirm deadline minus a margin. Null if the deadline is unreadable. */
export function probeGiveUpAt(
  deadlineAt: string,
  marginMs: number = PROBE_CONFIRM_MARGIN_MS
): number | null {
  const at = Date.parse(deadlineAt)
  return Number.isNaN(at) ? null : at - marginMs
}

/**
 * Decide, after a new ruleset is loaded, whether it can be confirmed. A
 * `confirm` or `unavailable` answer is final at once; a `withhold` is
 * re-checked every few seconds until `deadlineMs` in case the first round ran
 * before the rules settled. Returns a decision only: sending the confirm (or
 * not) is the caller's job.
 */
export async function decideAfterApply(deps: AfterApplyDeps): Promise<ConfirmationDecision> {
  const now = deps.now ?? Date.now
  const interval = deps.intervalMs ?? PROBE_POLL_INTERVAL_MS
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const poll = async (): Promise<ConfirmationDecision> => {
    const decision = decideConfirmation(deps.baseline, await deps.observe())
    if (decision.kind !== 'withhold') return decision
    if (now() + interval >= deps.deadlineMs) return decision
    await sleep(interval)
    return poll()
  }
  return poll()
}

/**
 * Take the "check now" slot for a server, atomically: true only when no check
 * started within {@link PROBE_MIN_INTERVAL_MS}. The slot is the probe record's
 * `at`, stored under `bulwark.last_result.probe` beside whatever else is there.
 */
export async function claimProbeSlot(
  db: Db,
  serverId: string,
  nowMs: number = Date.now(),
  minIntervalMs: number = PROBE_MIN_INTERVAL_MS
): Promise<boolean> {
  const at = new Date(nowMs).toISOString()
  const cutoff = new Date(nowMs - minIntervalMs).toISOString()
  const claim = JSON.stringify({
    probe: { at, phase: 'manual', status: 'running', ports: [], notes: [] },
  })
  const rows = await db.execute<{ server_id: string }>(sql`
    INSERT INTO bulwark (server_id, last_result)
    VALUES (${serverId}::uuid, ${claim}::jsonb)
    ON CONFLICT (server_id) DO UPDATE
    SET last_result = COALESCE(bulwark.last_result, '{}'::jsonb) || ${claim}::jsonb,
        updated_at = now()
    WHERE bulwark.last_result -> 'probe' ->> 'at' IS NULL
       OR (bulwark.last_result -> 'probe' ->> 'at')::timestamptz < ${cutoff}::timestamptz
    RETURNING server_id
  `)
  return [...rows].length > 0
}

/** Store the finished record beside the rest of `last_result`; never replaces the preview. */
export async function storeProbeRecord(
  db: Db,
  serverId: string,
  record: OutsideProbeRecord
): Promise<void> {
  const patch = JSON.stringify({ probe: record })
  await db
    .insert(bulwark)
    .values({ serverId, lastResult: { probe: record } })
    .onConflictDoUpdate({
      target: bulwark.serverId,
      set: { lastResult: sql`COALESCE(${bulwark.lastResult}, '{}'::jsonb) || ${patch}::jsonb` },
    })
}

/** The stored record of the last check, if `last_result` carries one. */
export function probeOfLastResult(lastResult: unknown): OutsideProbeRecord | null {
  if (typeof lastResult !== 'object' || lastResult === null) return null
  const probe = (lastResult as { probe?: unknown }).probe
  return typeof probe === 'object' && probe !== null ? (probe as OutsideProbeRecord) : null
}
