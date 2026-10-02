import { and, desc, eq, isNotNull, notInArray } from 'drizzle-orm'
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

export async function insertRecovery(
  db: Db,
  params: {
    managedId: string
    kind: RecoveryKind
    sourcePrimaryMemberId: string
    targetMemberId?: string | null
    state?: RecoveryState
    metadata?: RecoveryMetadata
  }
): Promise<RecoveryRecord> {
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

export async function updateRecovery(
  db: Db,
  recoveryId: string,
  patch: {
    state?: RecoveryState
    targetMemberId?: string | null
    metadata?: RecoveryMetadata
    completedAt?: string | null
  }
): Promise<RecoveryRecord | null> {
  const now = new Date().toISOString()
  const terminal = patch.state && (TERMINAL_RECOVERY_STATES as ReadonlySet<string>).has(patch.state)
  let completedAt: string | null | undefined
  if (patch.completedAt !== undefined) {
    completedAt = patch.completedAt
  } else if (terminal) {
    completedAt = now
  }
  const rows = await db
    .update(recovery)
    .set({
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.targetMemberId !== undefined ? { targetMemberId: patch.targetMemberId } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      completedAt,
      updatedAt: now,
    })
    .where(eq(recovery.id, recoveryId))
    .returning()
  const row = rows[0]
  return row ? serializeRow(row) : null
}

/** A `detecting` row older than this with no command queued is expired. */
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
 * Safety net for the stale sweep: a `detecting` row that nothing advanced
 * (no command queued) for {@link STALE_DETECTING_RECOVERY_MS} holds the
 * per-cluster in-flight slot and would lock switchover / DR out with
 * `managed_busy`. Expire it to terminal `blocked`. Returns the expired ids.
 */
export async function expireStaleDetectingRecoveries(
  db: Db,
  opts: { now?: number; maxAgeMs?: number; reason: string }
): Promise<string[]> {
  const nowMs = opts.now ?? Date.now()
  const maxAgeMs = opts.maxAgeMs ?? STALE_DETECTING_RECOVERY_MS
  const rows = await db.select().from(recovery).where(eq(recovery.state, 'detecting'))
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
