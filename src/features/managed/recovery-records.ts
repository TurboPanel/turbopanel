import { and, desc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { recovery } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import {
  isRecoveryKind,
  isRecoveryState,
  parseRecoveryMetadata,
  type RecoveryKind,
  type RecoveryMetadata,
  type RecoveryRecord,
  type RecoveryState,
  TERMINAL_RECOVERY_STATES,
} from './recovery.ts'

const TERMINAL_STATES = [...TERMINAL_RECOVERY_STATES]

function serializeRow(row: typeof recovery.$inferSelect): RecoveryRecord | null {
  if (!isRecoveryKind(row.kind) || !isRecoveryState(row.state)) return null
  return {
    id: row.id,
    managedId: row.managedId,
    kind: row.kind,
    sourcePrimaryMemberId: row.sourcePrimaryMemberId,
    targetMemberId: row.targetMemberId,
    state: row.state,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    metadata: parseRecoveryMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function findRecoveryById(db: Db, recoveryId: string): Promise<RecoveryRecord | null> {
  const rows = await db.select().from(recovery).where(eq(recovery.id, recoveryId)).limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : null
}

export async function findInFlightRecovery(
  db: Db,
  managedId: string
): Promise<RecoveryRecord | null> {
  const rows = await db
    .select()
    .from(recovery)
    .where(and(eq(recovery.managedId, managedId), notInArray(recovery.state, TERMINAL_STATES)))
    .orderBy(desc(recovery.startedAt))
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : null
}

export async function findLatestRecovery(
  db: Db,
  managedId: string
): Promise<RecoveryRecord | null> {
  const inflight = await findInFlightRecovery(db, managedId)
  if (inflight) return inflight
  const rows = await db
    .select()
    .from(recovery)
    .where(eq(recovery.managedId, managedId))
    .orderBy(desc(recovery.startedAt))
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : null
}

/**
 * Newest automatic failover that was accepted (a target was chosen), in any
 * state. Backs the persisted per-cluster cooldown: it survives restarts
 * because it is the journal itself.
 */
export async function findLatestAcceptedAutomaticFailover(
  db: Db,
  managedId: string
): Promise<RecoveryRecord | null> {
  const rows = await db
    .select()
    .from(recovery)
    .where(
      and(
        eq(recovery.managedId, managedId),
        eq(recovery.kind, 'automatic-failover'),
        isNotNull(recovery.targetMemberId)
      )
    )
    .orderBy(desc(recovery.startedAt))
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : null
}

type InsertRecoveryParams = {
  managedId: string
  kind: RecoveryKind
  sourcePrimaryMemberId: string
  targetMemberId?: string | null
  state?: RecoveryState
  metadata?: RecoveryMetadata
}

const UNIQUE_VIOLATION = '23505'

/** True for a Postgres unique violation, however the driver wraps it. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 3 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

async function insertRecoveryRow(db: Db, params: InsertRecoveryParams): Promise<RecoveryRecord> {
  const now = new Date().toISOString()
  const rows = await db
    .insert(recovery)
    .values({
      managedId: params.managedId,
      kind: params.kind,
      sourcePrimaryMemberId: params.sourcePrimaryMemberId,
      targetMemberId: params.targetMemberId ?? null,
      state: params.state ?? 'detecting',
      startedAt: now,
      metadata: params.metadata ?? {},
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('Failed to create recovery')
  const serialized = serializeRow(row)
  if (!serialized) throw new Error('Failed to serialize recovery')
  return serialized
}

/**
 * Insert a recovery row, or return `null` when another recovery already holds
 * the cluster's in-flight slot (the partial unique index): two events racing
 * past the in-flight check lose cleanly instead of throwing.
 */
export async function insertRecoveryIfFree(
  db: Db,
  params: InsertRecoveryParams
): Promise<RecoveryRecord | null> {
  try {
    return await insertRecoveryRow(db, params)
  } catch (error) {
    if (isUniqueViolation(error)) return null
    throw error
  }
}

/** Insert a recovery row; if the in-flight slot is taken, return that row. */
export async function insertRecovery(
  db: Db,
  params: InsertRecoveryParams
): Promise<RecoveryRecord> {
  const created = await insertRecoveryIfFree(db, params)
  if (created) return created
  const inflight = await findInFlightRecovery(db, params.managedId)
  if (inflight) return inflight
  throw new Error('Failed to create recovery')
}

/**
 * Record a refused automatic failover (terminal `blocked`, no target). A
 * flapping detector re-sends the same refused event every poll, so when the
 * newest row of the cluster is already the same refusal, count it on that row
 * instead of adding another.
 */
export async function recordBlockedRecovery(
  db: Db,
  params: InsertRecoveryParams & { metadata: RecoveryMetadata & { blockedReason: string } }
): Promise<RecoveryRecord> {
  const latest = await findLatestRecovery(db, params.managedId)
  if (
    latest &&
    latest.kind === params.kind &&
    latest.state === 'blocked' &&
    latest.targetMemberId === null &&
    latest.sourcePrimaryMemberId === params.sourcePrimaryMemberId &&
    latest.metadata.blockedReason === params.metadata.blockedReason
  ) {
    const updated = await updateRecovery(db, latest.id, {
      metadata: {
        ...latest.metadata,
        ...params.metadata,
        blockedCount: (latest.metadata.blockedCount ?? 1) + 1,
        lastBlockedAt: new Date().toISOString(),
      },
    })
    if (updated) return updated
  }
  return await insertRecovery(db, { ...params, state: 'blocked' })
}

export type RecoveryPatch = {
  state?: RecoveryState
  targetMemberId?: string | null
  metadata?: RecoveryMetadata
  completedAt?: string | null
}

function recoveryPatchColumns(patch: RecoveryPatch) {
  const now = new Date().toISOString()
  const terminal = patch.state && (TERMINAL_RECOVERY_STATES as ReadonlySet<string>).has(patch.state)
  let completedAt: string | null | undefined
  if (patch.completedAt !== undefined) {
    completedAt = patch.completedAt
  } else if (terminal) {
    completedAt = now
  }
  return {
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.targetMemberId !== undefined ? { targetMemberId: patch.targetMemberId } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    completedAt,
    updatedAt: now,
  }
}

export async function updateRecovery(
  db: Db,
  recoveryId: string,
  patch: RecoveryPatch
): Promise<RecoveryRecord | null> {
  const rows = await db
    .update(recovery)
    .set(recoveryPatchColumns(patch))
    .where(eq(recovery.id, recoveryId))
    .returning()
  const row = rows[0]
  return row ? serializeRow(row) : null
}

/**
 * Read-modify-write of one live (non-terminal) recovery row under a row lock
 * (`SELECT … FOR UPDATE` in a transaction), so concurrent writers — parallel
 * queue consumers delivering fence results — serialize instead of losing each
 * other's `fenceCommandIds` edits. `decide` sees the locked current row and
 * returns the patch, or null to leave it untouched. Returns the updated row,
 * or null when nothing was written (missing, terminal, or declined).
 *
 * `decide` must be pure: never queue commands or open another transaction
 * while the lock is held; act on the returned row after the commit.
 */
export async function updateRecoveryLocked(
  db: Db,
  recoveryId: string,
  decide: (current: RecoveryRecord) => RecoveryPatch | null
): Promise<RecoveryRecord | null> {
  return await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(recovery)
      .where(eq(recovery.id, recoveryId))
      .for('update')
      .limit(1)
    const current = locked ? serializeRow(locked) : null
    if (!current || (TERMINAL_RECOVERY_STATES as ReadonlySet<string>).has(current.state)) {
      return null
    }
    const patch = decide(current)
    if (!patch) return null
    const rows = await tx
      .update(recovery)
      .set(recoveryPatchColumns(patch))
      .where(eq(recovery.id, recoveryId))
      .returning()
    const row = rows[0]
    return row ? serializeRow(row) : null
  })
}

/** A `detecting`/`fencing` row older than this with no command queued is expired. */
export const STALE_DETECTING_RECOVERY_MS = 10 * 60_000

function hasQueuedCommands(metadata: RecoveryMetadata): boolean {
  return Boolean(
    (metadata.fenceCommandIds?.length ?? 0) > 0 ||
    metadata.promoteCommandId ||
    metadata.failoverCommandId ||
    (metadata.ingressCommandIds?.length ?? 0) > 0
  )
}

/**
 * Safety net for the stale sweep: a `detecting` or `fencing` row that nothing
 * advanced (no command recorded in its metadata) for
 * {@link STALE_DETECTING_RECOVERY_MS} holds the per-cluster in-flight slot
 * and would lock switchover / DR out with `managed_busy`. Expire it to
 * terminal `blocked`. Returns the expired ids.
 */
export async function expireStaleDetectingRecoveries(
  db: Db,
  opts: { now?: number; maxAgeMs?: number; reason: string }
): Promise<string[]> {
  const nowMs = opts.now ?? Date.now()
  const maxAgeMs = opts.maxAgeMs ?? STALE_DETECTING_RECOVERY_MS
  const rows = await db
    .select()
    .from(recovery)
    .where(inArray(recovery.state, ['detecting', 'fencing']))
  const stale = rows
    .map((row) => serializeRow(row))
    .filter((row): row is RecoveryRecord => row !== null)
    .filter((row) => {
      const started = Date.parse(row.startedAt)
      return (
        Number.isFinite(started) && nowMs - started >= maxAgeMs && !hasQueuedCommands(row.metadata)
      )
    })
  const expired: string[] = []
  await forEachSequential(stale, async (row) => {
    const updated = await updateRecovery(db, row.id, {
      state: 'blocked',
      metadata: { ...row.metadata, blockedReason: opts.reason },
    })
    if (updated) expired.push(updated.id)
  })
  return expired
}
