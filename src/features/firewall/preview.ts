/**
 * Send a server its firewall PREVIEW as `server.firewall.reconcile`.
 *
 * This is the first place the control plane ever sends that command, and it is
 * deliberately incapable of changing a host: the wire mode comes from
 * {@link wireModeFor}, which answers `observe` while `FIREWALL_APPLY_ENABLED`
 * is false, so the daemon renders the ruleset, asks the kernel to check it
 * (`iptables-restore --test`) and loads nothing. A server whose stored mode is
 * `off` is sent nothing at all.
 *
 * What the host answered is kept in `bulwark.last_result` wrapped as
 * `{ kind: 'preview', ... }`; `last_applied_at` is never set from here, so a
 * stored preview can never be read as "this is enforced".
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
  type FirewallReconcileCommandPayload,
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
import { wireModeFor } from './enforcement.ts'
import { type LoadedFirewallFacts, loadFirewallFacts } from './facts.ts'
import { nextBulwarkGeneration } from './records.ts'

export const FIREWALL_RECONCILE_COMMAND = 'server.firewall.reconcile'

/** Servers one sweep tick previews at most. */
const FIREWALL_PREVIEW_SWEEP_CAP = 100

export type FirewallPreviewActor = { actorType: string; actorId: string }

export type FirewallPreviewStatus = 'queued' | 'previewed' | 'refused' | 'failed'

/** What `bulwark.last_result` holds while stage 4 is the only sender. */
export type FirewallPreviewRecord = {
  kind: 'preview'
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
  /** Send even when the desired set is unchanged (after a reconnect). */
  force?: boolean
  /** Only refresh a server that already has a stored preview. */
  onlyIfPreviewed?: boolean
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

/** What one server is sent, or null when its mode is `off` (nothing is sent to it). */
export async function previewFromFacts(facts: LoadedFirewallFacts): Promise<PreviewBuild | null> {
  if (facts.mode === 'off') return null
  const derivation = deriveFirewall(facts.input)
  const payload: PreviewBuild['payload'] = {
    mode: wireModeFor(facts.mode),
    policy: derivation.policy,
    rules: derivation.rules,
  }
  if (derivation.controlPlane) payload.controlPlane = derivation.controlPlane
  if (derivation.sshPorts) payload.sshPorts = derivation.sshPorts
  const desiredDigest = await sha256HexUtf8(JSON.stringify(payload))
  return { payload, desiredDigest, notes: [...facts.notes, ...derivation.notes] }
}

async function buildPreview(db: Db, serverId: string): Promise<PreviewBuild | null> {
  const facts = await loadFirewallFacts(db, serverId)
  return facts ? await previewFromFacts(facts) : null
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

async function readStoredDesiredDigest(db: Db, serverId: string): Promise<string | null> {
  const rows = await db.execute<{ digest: string | null }>(sql`
    SELECT last_result ->> 'desiredDigest' AS digest
    FROM bulwark
    WHERE server_id = ${serverId} AND last_result ->> 'kind' = 'preview'
  `)
  return rows[0]?.digest ?? null
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

/** Build, validate and queue one server's preview. True when a command was queued. */
async function previewOne(
  db: Db,
  queue: CommandQueue,
  actor: FirewallPreviewActor,
  serverId: string,
  options: PreviewOptions
): Promise<'queued' | 'skipped'> {
  const built = await buildPreview(db, serverId)
  if (!built) return 'skipped'
  const stored = await readStoredDesiredDigest(db, serverId)
  // A server never previewed gets its first one from the reconnect sweep or a
  // settings write; a deploy only refreshes a preview that already exists.
  if (stored === null && options.onlyIfPreviewed === true) return 'skipped'
  const changed = stored !== built.desiredDigest
  if (!changed && options.force !== true) return 'skipped'
  // The generation rises only when the desired set did; a reconnect re-send
  // of an unchanged set keeps the number the host already knows.
  const generation = changed
    ? await nextBulwarkGeneration(db, serverId)
    : await currentGeneration(db, serverId)
  const payload = parseFirewallReconcilePayload({ ...built.payload, generation })
  await storePreviewRecord(db, serverId, generation, {
    kind: 'preview',
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
  organizationId: string
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
      rows.map((row) => row.id)
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
 * Servers whose mode is `off` are left out. Runs from the Workers cron and the
 * Deno maintenance timer, never from hello or a Durable Object handler.
 */
export async function runFirewallPreviewSweep(
  db: Db,
  queue: CommandQueue,
  params: Readonly<{ budget?: number }> = {}
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
      AND COALESCE(bw.mode, 'observe') <> 'off'
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
      { force: true }
    )
    enqueued += result.queuedServerIds.length
  })
  return { enqueued }
}

/**
 * Keep what the host answered, beside the preview it answered. Only a preview
 * the control plane sent is recorded: a result for any other mode is left for
 * the stage that sends it. `last_applied_at` is not touched.
 */
export async function recordFirewallPreviewResult(
  db: Db,
  serverId: string,
  payloadValue: unknown,
  resultValue: unknown
): Promise<void> {
  const payload = parseFirewallReconcilePayload(payloadValue)
  if (payload.mode !== 'observe') return
  const result = parseFirewallReconcileResult(resultValue)
  const stored = await readStoredPreview(db, serverId)
  if (stored?.generation !== payload.generation) return
  const status: FirewallPreviewStatus =
    result.validation && !result.validation.ok ? 'refused' : 'previewed'
  await db
    .insert(bulwark)
    .values({ serverId, generation: payload.generation })
    .onConflictDoUpdate({
      target: bulwark.serverId,
      set: { lastDigest: result.digest, lastResult: { ...stored, status, host: result } },
    })
}

async function readStoredPreview(db: Db, serverId: string): Promise<FirewallPreviewRecord | null> {
  const rows = await db.execute<{ last_result: FirewallPreviewRecord | null }>(sql`
    SELECT last_result FROM bulwark
    WHERE server_id = ${serverId} AND last_result ->> 'kind' = 'preview'
  `)
  return rows[0]?.last_result ?? null
}

/** The stored preview, if `last_result` is one; for the read-only route. */
export function previewOfLastResult(lastResult: unknown): FirewallPreviewRecord | null {
  if (typeof lastResult !== 'object' || lastResult === null) return null
  return (lastResult as { kind?: unknown }).kind === 'preview'
    ? (lastResult as FirewallPreviewRecord)
    : null
}
