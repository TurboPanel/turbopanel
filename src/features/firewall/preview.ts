/**
 * Send a server its firewall PREVIEW as `server.firewall.reconcile`.
 *
 * This is the only place the control plane sends that command, and by default
 * it cannot change a host: the wire mode comes from {@link planWireMode},
 * which answers `observe` unless BOTH keys of `enforcement.ts` are turned for
 * that one server (the deploy-time allowlist and a stored mode `managed`), so
 * the daemon renders the ruleset, asks the kernel to check it
 * (`iptables-restore --test`) and loads nothing. A server whose stored mode is
 * `off` is sent nothing at all, unless it still carries an apply (below).
 *
 * **Apply, for the one allowed server.** `managed` goes out; the daemon arms
 * its root rollback guard before loading anything and the rules stay pending
 * until `turbopaneld firewall confirm` on the host (this build never sends
 * `server.firewall.confirm`). **Teardown.** When a server that was sent an
 * apply loses either key, it is sent `mode: "off"` (remove TurboPanel's chains
 * and jumps, forget the documents, stop the guard) until the host reports the
 * removal; only then does it go back to plain previews. Teardown is never
 * gated by the switch: it only moves the host toward ACCEPT.
 *
 * What the host answered is kept in `bulwark.last_result` as a record whose
 * `kind` says what was sent: `preview` (observe), `apply` (managed) or
 * `remove` (off). Only an `apply` the host reports as applied sets
 * `last_applied_at`, so a stored preview can never be read as "this is enforced".
 *
 * Every enqueue is best-effort and **never throws**: it runs after the write
 * that changed the desired set, and that write has already succeeded. A server
 * that misses one is caught by {@link runFirewallPreviewSweep}, which sends
 * once after each reconnect.
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { bulwark } from '../../db/schema.ts'
import {
  type FirewallMode,
  type FirewallReconcileCommandPayload,
  type FirewallReconcileCommandResult,
  parseFirewallReconcilePayload,
  parseFirewallReconcileResult,
} from '../../contracts/commands/schemas.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { createCommandRecord, transitionCommand } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import { isNoopCommandQueue } from '../commands/noop-command-queue.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { sha256HexUtf8 } from '../compose/desired-hash.ts'
import { deriveFirewall } from './derive.ts'
import { applyAllowedFor, type FirewallApplyGate, wireModeFor } from './enforcement.ts'
import { type LoadedFirewallFacts, loadFirewallFacts } from './facts.ts'
import { nextBulwarkGeneration } from './records.ts'
import type { FirewallModeValue } from './vocabulary.ts'

export const FIREWALL_RECONCILE_COMMAND = 'server.firewall.reconcile'

/** Servers one sweep tick previews at most. */
const FIREWALL_PREVIEW_SWEEP_CAP = 100

export type FirewallPreviewActor = { actorType: string; actorId: string }

export type FirewallPreviewStatus =
  'queued' | 'previewed' | 'applied' | 'removed' | 'refused' | 'failed'

/** What was sent: a preview (observe), an apply (managed) or a teardown (off). */
export type FirewallRecordKind = 'preview' | 'apply' | 'remove'

const RECORD_KINDS: readonly string[] = ['preview', 'apply', 'remove']

const KIND_OF_MODE: Record<FirewallMode, FirewallRecordKind> = {
  observe: 'preview',
  managed: 'apply',
  off: 'remove',
}

/** What `bulwark.last_result` holds: the last reconcile sent and what the host answered. */
export type FirewallPreviewRecord = {
  kind: FirewallRecordKind
  status: FirewallPreviewStatus
  /** sha256 of the desired set this preview was built from; the "did it change" key. */
  desiredDigest: string
  generation: number
  sentAt: string
  ruleCount: number
  /** Plain-words facts about what could not be derived, shown beside the preview. */
  notes: string[]
  /** The host's own answer: warnings, validation, and the rendered text. Null until it answers. */
  host: unknown
}

type PreviewOptions = {
  /** Send even when the desired set is unchanged (after a reconnect); never re-sends an unchanged apply. */
  force?: boolean
  /** Only refresh a server that already has a stored preview. */
  onlyIfPreviewed?: boolean
  /** The deploy-time key (`TURBOPANEL_FIREWALL_APPLY_SERVERS`); absent means no server may apply. */
  applyGate?: FirewallApplyGate
}

/** Build options: is apply allowed for this server, and does it still carry an apply to undo? */
export type PreviewPlanOptions = {
  applyAllowed?: boolean
  teardown?: boolean
}

export type FirewallPreviewOutcome = {
  queuedServerIds: string[]
  failedServerIds: string[]
}

export type PreviewBuild = {
  payload: Omit<FirewallReconcileCommandPayload, 'generation'>
  desiredDigest: string
  notes: string[]
}

/**
 * The wire mode for one server, or null when nothing is sent. `managed` only
 * when apply is allowed and the stored mode asks for it; otherwise a server
 * that still carries an apply is sent `off` (teardown), and the rest `observe`
 * (or nothing, when stored `off`).
 */
export function planWireMode(
  stored: FirewallModeValue,
  options: PreviewPlanOptions = {}
): FirewallMode | null {
  const wire = stored === 'off' ? null : wireModeFor(stored, options.applyAllowed === true)
  if (wire === 'managed') return wire
  return options.teardown === true ? 'off' : wire
}

/** True while the last thing sent was an apply, or a teardown the host has not reported done. */
export function needsTeardown(stored: FirewallPreviewRecord | null): boolean {
  if (stored === null) return false
  if (stored.kind === 'apply') return true
  return stored.kind === 'remove' && stored.status !== 'removed'
}

/** What one server is sent, or null when nothing is (mode `off`, nothing to undo). */
export async function previewFromFacts(
  facts: LoadedFirewallFacts,
  options: PreviewPlanOptions = {}
): Promise<PreviewBuild | null> {
  const mode = planWireMode(facts.mode, options)
  if (mode === null) return null
  const derivation = deriveFirewall(facts.input)
  const payload: PreviewBuild['payload'] = {
    mode,
    policy: derivation.policy,
    rules: mode === 'off' ? [] : derivation.rules,
  }
  if (mode !== 'off' && derivation.controlPlane) payload.controlPlane = derivation.controlPlane
  if (mode !== 'off' && derivation.sshPorts) payload.sshPorts = derivation.sshPorts
  const desiredDigest = await sha256HexUtf8(JSON.stringify(payload))
  return { payload, desiredDigest, notes: [...facts.notes, ...derivation.notes] }
}

async function buildPreview(
  db: Db,
  serverId: string,
  options: PreviewPlanOptions
): Promise<PreviewBuild | null> {
  const facts = await loadFirewallFacts(db, serverId)
  return facts ? await previewFromFacts(facts, options) : null
}

async function storePreviewRecord(
  db: Db,
  serverId: string,
  generation: number,
  record: FirewallPreviewRecord
): Promise<void> {
  await db
    .insert(bulwark)
    .values({ serverId, generation, lastResult: record })
    .onConflictDoUpdate({ target: bulwark.serverId, set: { lastResult: record } })
}

async function enqueuePreviewCommand(
  db: Db,
  queue: CommandQueue,
  actor: FirewallPreviewActor,
  serverId: string,
  payload: FirewallReconcileCommandPayload
): Promise<boolean> {
  const record = await createCommandRecord(db, {
    serverId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    type: FIREWALL_RECONCILE_COMMAND,
    payload,
  })
  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: FIREWALL_RECONCILE_COMMAND,
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
  try {
    await queue.enqueue(envelope)
    return true
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Failed to enqueue firewall preview',
    })
    return false
  }
}

/**
 * Whether to send at all. A changed set always goes; a teardown is re-sent
 * until the host reports it done; a reconnect (`force`) re-sends an unchanged
 * preview but never re-applies an unchanged ruleset, so a host whose guard
 * rolled an unconfirmed apply back is not re-armed on every reconnect.
 */
export function shouldSend(changed: boolean, mode: FirewallMode, force: boolean): boolean {
  if (changed || mode === 'off') return true
  return force && mode === 'observe'
}

/** Build, validate and queue one server's preview. True when a command was queued. */
async function previewOne(
  db: Db,
  queue: CommandQueue,
  actor: FirewallPreviewActor,
  serverId: string,
  options: PreviewOptions
): Promise<'queued' | 'skipped'> {
  const stored = await readStoredRecord(db, serverId)
  // A server never previewed gets its first one from the reconnect sweep or a
  // settings write; a deploy only refreshes a preview that already exists.
  if (stored === null && options.onlyIfPreviewed === true) return 'skipped'
  const built = await buildPreview(db, serverId, {
    applyAllowed: applyAllowedFor(serverId, options.applyGate),
    teardown: needsTeardown(stored),
  })
  if (!built) return 'skipped'
  const changed = stored?.desiredDigest !== built.desiredDigest
  if (!shouldSend(changed, built.payload.mode, options.force === true)) return 'skipped'
  // The generation rises only when the desired set did; a reconnect re-send
  // of an unchanged set keeps the number the host already knows.
  const generation = changed
    ? await nextBulwarkGeneration(db, serverId)
    : await currentGeneration(db, serverId)
  const payload = parseFirewallReconcilePayload({ ...built.payload, generation })
  await storePreviewRecord(db, serverId, generation, {
    kind: KIND_OF_MODE[payload.mode],
    status: 'queued',
    desiredDigest: built.desiredDigest,
    generation,
    sentAt: new Date().toISOString(),
    ruleCount: payload.rules.length,
    notes: built.notes,
    host: null,
  })
  return (await enqueuePreviewCommand(db, queue, actor, serverId, payload)) ? 'queued' : 'skipped'
}

async function currentGeneration(db: Db, serverId: string): Promise<number> {
  const rows = await db.execute<{ generation: number }>(
    sql`SELECT generation FROM bulwark WHERE server_id = ${serverId}`
  )
  return rows[0]?.generation ?? (await nextBulwarkGeneration(db, serverId))
}

function canEnqueue(queue: CommandQueue | undefined): queue is CommandQueue {
  return queue !== undefined && !isNoopCommandQueue(queue)
}

/**
 * Preview each server once, if what it should show changed (or `force`, for a
 * reconnect). Mode `off` servers are skipped. Never throws.
 */
export async function enqueueFirewallPreview(
  db: Db,
  queue: CommandQueue | undefined,
  actor: FirewallPreviewActor,
  serverIds: readonly (string | null | undefined)[],
  options: PreviewOptions = {}
): Promise<FirewallPreviewOutcome> {
  const unique = [...new Set(serverIds.filter((id): id is string => typeof id === 'string'))]
  const outcome: FirewallPreviewOutcome = { queuedServerIds: [], failedServerIds: [] }
  if (!canEnqueue(queue)) return { queuedServerIds: [], failedServerIds: unique }
  await forEachSequential(unique, async (serverId) => {
    try {
      if ((await previewOne(db, queue, actor, serverId, options)) === 'queued') {
        outcome.queuedServerIds.push(serverId)
      }
    } catch (err) {
      compatLogWarn('firewall', `firewall preview for server ${serverId} failed: ${String(err)}`)
      outcome.failedServerIds.push(serverId)
    }
  })
  return outcome
}

/** Every server of an organization, for a policy or an any-server rule change. */
export async function enqueueFirewallPreviewForOrganization(
  db: Db,
  queue: CommandQueue | undefined,
  actor: FirewallPreviewActor,
  organizationId: string,
  options: Pick<PreviewOptions, 'applyGate'> = {}
): Promise<FirewallPreviewOutcome> {
  if (!canEnqueue(queue)) return { queuedServerIds: [], failedServerIds: [] }
  try {
    const rows = await db.execute<{ id: string }>(sql`
      SELECT id FROM server
      WHERE organization_id = ${organizationId} AND is_connected = true
      ORDER BY id
      LIMIT ${FIREWALL_PREVIEW_SWEEP_CAP}
    `)
    return await enqueueFirewallPreview(
      db,
      queue,
      actor,
      rows.map((row) => row.id),
      options
    )
  } catch (err) {
    compatLogWarn('firewall', `firewall preview for organization failed: ${String(err)}`)
    return { queuedServerIds: [], failedServerIds: [] }
  }
}

/** Command types whose success can change what a host publishes or listens on. */
const PREVIEW_TRIGGER_COMMANDS: ReadonlySet<string> = new Set([
  'environment.deploy',
  'environment.stop',
  'environment.lifecycle',
  'managed.apply',
  'managed.destroy',
  'managed.ingress.reconcile',
  'managed.ha.reconcile',
  'server.fabric.reconcile',
])

export function commandMayChangeFirewallPreview(type: string): boolean {
  return PREVIEW_TRIGGER_COMMANDS.has(type)
}

/**
 * Reconnect trigger: preview each connected server once after it
 * (re)connects. "Once" is enforced by the command table: a server is skipped
 * when a firewall reconcile was already created since its `status_changed_at`.
 * Servers whose mode is `off` are left out unless they still carry an apply
 * to undo. Runs from the Deno maintenance timer, never from hello or a
 * Durable Object handler.
 */
export async function runFirewallPreviewSweep(
  db: Db,
  queue: CommandQueue,
  params: Readonly<{ budget?: number; applyGate?: FirewallApplyGate }> = {}
): Promise<{ enqueued: number }> {
  if (!canEnqueue(queue)) return { enqueued: 0 }
  const budget = Math.min(
    Math.max(1, params.budget ?? FIREWALL_PREVIEW_SWEEP_CAP),
    FIREWALL_PREVIEW_SWEEP_CAP
  )
  const candidates = await db.execute<{ server_id: string }>(sql`
    SELECT srv.id AS server_id
    FROM server srv
    LEFT JOIN bulwark bw ON bw.server_id = srv.id
    WHERE srv.is_connected = true
      AND srv.status_changed_at IS NOT NULL
      AND (
        COALESCE(bw.mode, 'observe') <> 'off'
        OR bw.last_result ->> 'kind' IN ('apply', 'remove')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM command cmd
        WHERE cmd.server_id = srv.id
          AND cmd.name = ${FIREWALL_RECONCILE_COMMAND}
          AND cmd.created_at >= srv.status_changed_at
      )
    ORDER BY srv.id
    LIMIT ${budget}
  `)
  let enqueued = 0
  await forEachSequential(candidates, async (row) => {
    const result = await enqueueFirewallPreview(
      db,
      queue,
      { actorType: 'system', actorId: row.server_id },
      [row.server_id],
      { force: true, applyGate: params.applyGate }
    )
    enqueued += result.queuedServerIds.length
  })
  return { enqueued }
}

/** The status a host's answer gives the record of what was sent. */
export function statusOfResult(
  mode: FirewallMode,
  result: FirewallReconcileCommandResult
): FirewallPreviewStatus {
  if (result.validation && !result.validation.ok) return 'refused'
  if (mode === 'observe') return 'previewed'
  if (!result.applied) return 'refused'
  return mode === 'managed' ? 'applied' : 'removed'
}

/**
 * The bulwark columns an answer moves: an applied ruleset is pending until its
 * deadline (this build does not yet learn a host-side confirm or rollback), a
 * reported teardown is idle again. Previews and refusals move nothing.
 */
export function bulwarkStateOfResult(
  status: FirewallPreviewStatus,
  result: FirewallReconcileCommandResult,
  now: string
): Partial<typeof bulwark.$inferInsert> {
  if (status === 'applied') {
    return {
      state: 'pending',
      deadlineAt: result.confirmation?.deadlineAt ?? null,
      lastAppliedAt: now,
    }
  }
  if (status === 'removed') return { state: 'idle', deadlineAt: null }
  return {}
}

/**
 * Keep what the host answered, beside the record of what was sent. A result
 * for a generation or kind other than the stored one is stale and ignored.
 */
export async function recordFirewallPreviewResult(
  db: Db,
  serverId: string,
  payloadValue: unknown,
  resultValue: unknown
): Promise<void> {
  const payload = parseFirewallReconcilePayload(payloadValue)
  const result = parseFirewallReconcileResult(resultValue)
  const stored = await readStoredRecord(db, serverId)
  if (stored?.generation !== payload.generation) return
  if (stored.kind !== KIND_OF_MODE[payload.mode]) return
  const status = statusOfResult(payload.mode, result)
  await db
    .insert(bulwark)
    .values({ serverId, generation: payload.generation })
    .onConflictDoUpdate({
      target: bulwark.serverId,
      set: {
        // A teardown answers with an empty digest: nothing is loaded, so no drift key.
        lastDigest: result.digest === '' ? null : result.digest,
        lastResult: { ...stored, status, host: result },
        ...bulwarkStateOfResult(status, result, new Date().toISOString()),
      },
    })
}

async function readStoredRecord(db: Db, serverId: string): Promise<FirewallPreviewRecord | null> {
  const rows = await db.execute<{ last_result: unknown }>(sql`
    SELECT last_result FROM bulwark WHERE server_id = ${serverId}
  `)
  return previewOfLastResult(rows[0]?.last_result ?? null)
}

/** The stored record of the last reconcile sent, if `last_result` is one; for the read-only route. */
export function previewOfLastResult(lastResult: unknown): FirewallPreviewRecord | null {
  if (typeof lastResult !== 'object' || lastResult === null) return null
  const kind = (lastResult as { kind?: unknown }).kind
  return typeof kind === 'string' && RECORD_KINDS.includes(kind)
    ? (lastResult as FirewallPreviewRecord)
    : null
}
