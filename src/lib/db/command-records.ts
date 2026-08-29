import { desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { commandContextFromPayload } from '../commands/context.ts'
import { nowIso } from '../commands/ids.ts'
import { type CommandStatus, TERMINAL_COMMAND_STATUSES } from '../commands/types.ts'
import { command, dispatch } from './schema.ts'
import { sealExecutionLogOnTerminal } from '../execution-logs/seal-on-terminal.ts'

/**
 * Explicit `command` select list. The daemon execution payload lives in
 * `dispatch`, never on this row — **never widen this select list with a
 * join onto `dispatch`**. Dispatch payload is read only through
 * {@link getCommandDispatchPayload}.
 */
const COMMAND_COLUMNS = {
  id: command.id,
  createdAt: command.createdAt,
  updatedAt: command.updatedAt,
  serverId: command.serverId,
  actorType: command.actorType,
  actorId: command.actorId,
  name: command.name,
  status: command.status,
  attempts: command.attempts,
  context: command.context,
  resultSummary: command.resultSummary,
  errorCode: command.errorCode,
  errorMessage: command.errorMessage,
  queuedAt: command.queuedAt,
  dispatchStartedAt: command.dispatchStartedAt,
  sentAt: command.sentAt,
  ackedAt: command.ackedAt,
  startedAt: command.startedAt,
  finishedAt: command.finishedAt,
  expiresAt: command.expiresAt,
} as const

type CommandDbRow = {
  [K in keyof typeof COMMAND_COLUMNS]: (typeof command.$inferSelect)[K]
}

export type CommandRecord = {
  id: string
  serverId: string
  actorEntityType: string
  actorEntityId: string
  type: string
  status: CommandStatus
  /** Small non-secret identifier bag captured at enqueue time. */
  context: unknown
  result: unknown
  errorCode: string | null
  /** Canonical human-readable error for terminal failures. */
  errorMessage: string | null
  /** @deprecated Legacy alias for {@link CommandRecord.errorMessage}. */
  error: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  queuedAt: string | null
  dispatchStartedAt: string | null
  sentAt: string | null
  ackedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string | null
}

type CreateCommandRecordParams = {
  serverId: string
  actorType: string
  actorId: string
  type: string
  /** Daemon execution payload — stored in `dispatch`, not on `command`. */
  payload: unknown
  /**
   * Small non-secret identifiers only (no secrets, compose YAML, or TLS
   * material). Defaults to the allowlisted identifiers extracted from
   * `payload` by {@link commandContextFromPayload}, so every enqueue site gets a
   * consistent context bag without hand-copying fields.
   */
  context?: unknown
  expiresAt?: string
  /** Additional metadata keys merged into the command row (follow-up chains). */
  metadata?: Record<string, unknown>
}

type ListServerCommandsParams = {
  serverId: string
  limit?: number
}

type CommandTransitionPatch = {
  status: CommandStatus
  result?: unknown
  error?: string
  errorCode?: string
  attempts?: number
  queuedAt?: string
  dispatchStartedAt?: string
  sentAt?: string
  ackedAt?: string
  startedAt?: string
  finishedAt?: string
}

const STATUS_TIMESTAMP_FIELD: Partial<
  Record<CommandStatus, LifecycleTimestampField>
> = {
  queued: 'queuedAt',
  dispatching: 'dispatchStartedAt',
  sent: 'sentAt',
  acked: 'ackedAt',
  running: 'startedAt',
  succeeded: 'finishedAt',
  failed: 'finishedAt',
  timed_out: 'finishedAt',
  cancelled: 'finishedAt',
}

const LIFECYCLE_TIMESTAMP_FIELDS = [
  'queuedAt',
  'dispatchStartedAt',
  'sentAt',
  'ackedAt',
  'startedAt',
  'finishedAt',
] as const

type LifecycleTimestampField = (typeof LIFECYCLE_TIMESTAMP_FIELDS)[number]

/**
 * postgres.js `mode: 'string'` timestamptz values arrive as Postgres text
 * (`YYYY-MM-DD HH:mm:ss.ss+00`), not ISO-8601. {@link CommandRecord} timestamps
 * are a public API contract (same shape as {@link nowIso}).
 */
function toIsoTimestamp(value: string | Date | null | undefined): string | null {
  if (value == null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return typeof value === 'string' ? value : null
  }
  return parsed.toISOString()
}

export function serializeCommandRecord(row: CommandDbRow): CommandRecord {
  return {
    id: row.id,
    serverId: row.serverId,
    actorEntityType: row.actorType,
    actorEntityId: row.actorId,
    type: row.name,
    status: (row.status ?? 'queued') as CommandStatus,
    context: row.context ?? null,
    result: row.resultSummary ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    error: row.errorMessage ?? null,
    attempts: row.attempts ?? 0,
    createdAt: toIsoTimestamp(row.createdAt) ?? row.createdAt,
    updatedAt: toIsoTimestamp(row.updatedAt) ?? row.updatedAt,
    queuedAt: toIsoTimestamp(row.queuedAt),
    dispatchStartedAt: toIsoTimestamp(row.dispatchStartedAt),
    sentAt: toIsoTimestamp(row.sentAt),
    ackedAt: toIsoTimestamp(row.ackedAt),
    startedAt: toIsoTimestamp(row.startedAt),
    finishedAt: toIsoTimestamp(row.finishedAt),
    expiresAt: toIsoTimestamp(row.expiresAt),
  }
}

/**
 * Insert the permanent `command` row and its `dispatch` payload row in
 * one transaction — a command never exists without its dispatch payload.
 */
export async function createCommandRecord(
  db: Db,
  params: CreateCommandRecordParams,
): Promise<CommandRecord> {
  const now = nowIso()
  const context = params.context ?? commandContextFromPayload(params.payload)

  const row = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(command)
      .values({
        serverId: params.serverId,
        actorType: params.actorType,
        actorId: params.actorId,
        name: params.type,
        status: 'queued',
        attempts: 0,
        queuedAt: now,
        ...(context === undefined ? {} : { context }),
        ...(params.expiresAt === undefined ? {} : { expiresAt: params.expiresAt }),
        ...(params.metadata === undefined ? {} : { metadata: params.metadata }),
      })
      .returning(COMMAND_COLUMNS)

    const inserted = rows[0]
    if (!inserted) {
      throw new Error('Failed to create command record')
    }

    await tx.insert(dispatch).values({
      commandId: inserted.id,
      payload: params.payload,
    })

    return inserted
  })

  return serializeCommandRecord(row)
}

/**
 * Read raw command.metadata jsonb (for follow-up chains). Not flattened into
 * {@link CommandRecord}.
 */
export async function getCommandMetadata(
  db: Db,
  commandId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ metadata: command.metadata })
    .from(command)
    .where(eq(command.id, commandId))
    .limit(1)
  const meta = rows[0]?.metadata
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return null
  }
  return meta as Record<string, unknown>
}

/**
 * Take a one-shot claim on a command row, so exactly one caller runs a
 * follow-up.
 *
 * Several sibling commands can finish at once and each notice that a fan-out
 * gate is now satisfied. They all try to claim the same anchor row; the
 * conditional UPDATE means Postgres picks the winner and everyone else gets
 * `false`. Idempotent by construction — a second call for the same `flag` never
 * claims again, so a redelivered command cannot double-enqueue the follow-up.
 *
 * `flag` must be a fixed identifier from the calling code, never user input:
 * it becomes a jsonb key.
 */
export async function claimCommandMetadataFlag(
  db: Db,
  commandId: string,
  flag: string,
): Promise<boolean> {
  const claimed = await db
    .update(command)
    .set({
      metadata: sql`COALESCE(${command.metadata}, '{}'::jsonb) || jsonb_build_object(${flag}::text, ${nowIso()}::text)`,
    })
    .where(
      // `jsonb_exists(...)` rather than the `?` operator: `?` is a placeholder
      // token in several drivers and does not survive every SQL-building path.
      sql`${command.id} = ${commandId} AND NOT jsonb_exists(COALESCE(${command.metadata}, '{}'::jsonb), ${flag})`,
    )
    .returning({ id: command.id })
  return claimed.length > 0
}

/**
 * The only sanctioned read of the daemon execution payload. Returns `null` once
 * the dispatch row has been cleaned up (success) or swept (expired failure).
 */
export async function getCommandDispatchPayload(
  db: Db,
  commandId: string,
): Promise<unknown> {
  const rows = await db
    .select({ payload: dispatch.payload })
    .from(dispatch)
    .where(eq(dispatch.commandId, commandId))
    .limit(1)
  const row = rows[0]
  return row ? row.payload : null
}

/** Idempotent — a no-op when the dispatch row is already gone. */
export async function deleteCommandDispatch(
  db: Db,
  commandId: string,
): Promise<void> {
  await db.delete(dispatch).where(eq(dispatch.commandId, commandId))
}

/**
 * Retain a terminal-failure dispatch payload for debugging: stamp `expires_at`
 * so the shared maintenance sweep deletes it later. No-op when the row is gone.
 */
export async function retainCommandDispatch(
  db: Db,
  commandId: string,
  expiresAt: string,
): Promise<void> {
  await db
    .update(dispatch)
    .set({ expiresAt })
    .where(eq(dispatch.commandId, commandId))
}

/**
 * How long a terminal-failure dispatch payload is retained for debugging before
 * the shared maintenance sweep deletes it. Success drops it immediately.
 */
export const COMMAND_DISPATCH_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000

/** Bounded per maintenance tick — cleanup must never dominate the sweep. */
export const COMMAND_DISPATCH_SWEEP_LIMIT = 200

/**
 * Bounded delete of dispatch payloads whose retention window elapsed. Returns
 * the number of rows removed (tracing only).
 */
export async function sweepExpiredCommandDispatch(
  db: Db,
  opts: { limit: number; now?: string },
): Promise<number> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), 1000)
  const now = opts.now ?? nowIso()

  // Bounded per tick: pick the oldest expired ids in a subquery, delete those.
  const deleted = await db
    .delete(dispatch)
    .where(
      sql`${dispatch.commandId} in (
        select command_id from ${dispatch}
        where expires_at is not null and expires_at < ${now}::timestamptz
        order by expires_at
        limit ${limit}
      )`,
    )
    .returning({ commandId: dispatch.commandId })

  return deleted.length
}

export async function getCommandRecord(
  db: Db,
  commandId: string,
): Promise<CommandRecord | null> {
  // Explicit column list — see COMMAND_COLUMNS; never joins `dispatch`.
  const rows = await db
    .select(COMMAND_COLUMNS)
    .from(command)
    .where(eq(command.id, commandId))
    .limit(1)
  const row = rows[0]
  return row ? serializeCommandRecord(row) : null
}

export async function listCommandRecordsByIds(
  db: Db,
  ids: readonly string[],
): Promise<CommandRecord[]> {
  if (ids.length === 0) return []
  // Explicit column list — see COMMAND_COLUMNS; never joins `dispatch`.
  const rows = await db
    .select(COMMAND_COLUMNS)
    .from(command)
    .where(inArray(command.id, [...ids]))
  return rows.map(serializeCommandRecord)
}

export async function listServerCommands(
  db: Db,
  params: ListServerCommandsParams,
): Promise<CommandRecord[]> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)

  // Explicit column list — see COMMAND_COLUMNS; never joins `dispatch`.
  const rows = await db
    .select(COMMAND_COLUMNS)
    .from(command)
    .where(eq(command.serverId, params.serverId))
    // Break ties when two commands share a `created_at` instant (common in tests
    // and burst enqueue). UUIDv7 ids are time-ordered so `id DESC` is newest-first.
    .orderBy(desc(command.createdAt), desc(command.id))
    .limit(limit)

  return rows.map(serializeCommandRecord)
}

/**
 * Grace window stamped on a dispatch row when the immediate delete on success
 * fails: the payload becomes sweep-eligible almost at once instead of lingering
 * forever with a null `expires_at`.
 */
export const COMMAND_DISPATCH_CLEANUP_FALLBACK_MS = 60 * 1000

/**
 * Terminal cleanup for the dispatch payload, tied to the command's terminal
 * transition wherever it happens (consumer outcome, enqueue failure, expiry):
 * `succeeded` drops the payload immediately, other terminal statuses keep it for
 * {@link COMMAND_DISPATCH_FAILURE_RETENTION_MS} via `expires_at` so the shared
 * maintenance sweep removes it later. Best effort — never fails the transition,
 * but never leaves a secret-bearing row unsweepable either: every path that
 * fails falls back to stamping `expires_at` so the sweep can still reach it.
 */
async function finalizeCommandDispatch(
  db: Db,
  commandId: string,
  status: CommandStatus,
): Promise<void> {
  if (!TERMINAL_COMMAND_STATUSES.has(status)) return

  const retentionMs =
    status === 'succeeded'
      ? COMMAND_DISPATCH_CLEANUP_FALLBACK_MS
      : COMMAND_DISPATCH_FAILURE_RETENTION_MS
  const expiresAt = new Date(Date.now() + retentionMs).toISOString()

  if (status === 'succeeded') {
    try {
      await deleteCommandDispatch(db, commandId)
      return
    } catch {
      // Fall through: stamp a near-term `expires_at` so the sweep still reaches
      // the payload rather than leaving it behind with `expires_at` null.
    }
  }

  try {
    await retainCommandDispatch(db, commandId, expiresAt)
    return
  } catch {
    // Retry once — a single hiccup must not strand a secret-bearing row.
  }

  try {
    await retainCommandDispatch(db, commandId, expiresAt)
  } catch {
    // Leftovers are swept later; a cleanup hiccup must not fail the transition.
  }
}

export async function transitionCommand(
  db: Db,
  commandId: string,
  patch: CommandTransitionPatch,
): Promise<CommandRecord | null> {
  const now = nowIso()
  const timestamps: Partial<Record<LifecycleTimestampField, string>> = {}

  for (const field of LIFECYCLE_TIMESTAMP_FIELDS) {
    const value = patch[field]
    if (value !== undefined) {
      timestamps[field] = value
    }
  }

  const statusField = STATUS_TIMESTAMP_FIELD[patch.status]
  if (statusField && timestamps[statusField] === undefined) {
    timestamps[statusField] = now
  }

  const rows = await db
    .update(command)
    .set({
      status: patch.status,
      updatedAt: now,
      ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
      ...(patch.result === undefined ? {} : { resultSummary: patch.result }),
      ...(patch.error === undefined ? {} : { errorMessage: patch.error }),
      ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
      ...timestamps,
    })
    .where(eq(command.id, commandId))
    .returning(COMMAND_COLUMNS)

  const row = rows[0]
  if (!row) return null

  await finalizeCommandDispatch(db, commandId, patch.status)
  // Compact the command transcript on the same terminal transition that
  // finalizes the dispatch payload. Best effort and sink-based (no store is
  // threaded through Postgres helpers) — see
  // `src/lib/execution-logs/seal-on-terminal.ts`.
  if (TERMINAL_COMMAND_STATUSES.has(patch.status)) {
    await sealExecutionLogOnTerminal(commandId)
  }
  return serializeCommandRecord(row)
}
