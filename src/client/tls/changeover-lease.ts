/**
 * Organization CA rotation journal lease.
 *
 * Concurrency is the partial-unique `uniq_rotation_inflight_organization`
 * index (`state = 'in_progress'`) plus an age-bounded steal of a crashed
 * in-progress row (same CAS shape as `tryBeginReencryptSweep`). The journal
 * row is the audit trail — it is never deleted; `endCaRotation` is implicit
 * via `awaiting_retire` / `completed` / `failed`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db.ts";
import { rotation } from "../../lib/db/schema.ts";

export const CA_ROTATION_STATES = [
  "in_progress",
  "awaiting_retire",
  "completed",
  "failed",
] as const;

export type CaRotationState = (typeof CA_ROTATION_STATES)[number];

/** States that block a new `POST /tls/ca/rotate`. */
export const CA_ROTATION_BLOCKING_STATES = [
  "in_progress",
  "awaiting_retire",
] as const;

/** Stale in-progress journal reclaim window (crashed isolate). */
export const CA_ROTATION_STALE_MS = 15 * 60 * 1000;

export type CaRotationJournalRow = {
  id: string;
  organizationId: string;
  fromCaGeneration: number;
  toCaGeneration: number;
  state: CaRotationState;
  startedAt: string;
  completedAt: string | null;
  results: unknown;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
};

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

function isCaRotationState(value: unknown): value is CaRotationState {
  return typeof value === "string" &&
    (CA_ROTATION_STATES as readonly string[]).includes(value);
}

function serializeJournalRow(
  row: typeof rotation.$inferSelect,
): CaRotationJournalRow | null {
  if (!isCaRotationState(row.state)) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    fromCaGeneration: row.fromCaGeneration,
    toCaGeneration: row.toCaGeneration,
    state: row.state,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    results: row.results,
    metadata: row.metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function journalIsStale(
  startedAt: string,
  nowMs = Date.now(),
): boolean {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return true;
  return nowMs - started >= CA_ROTATION_STALE_MS;
}

/**
 * Latest Organization CA rotation journal row for this org, if any.
 */
export async function loadLatestCaRotation(
  db: Db,
  organizationId: string,
): Promise<CaRotationJournalRow | null> {
  const [row] = await db
    .select()
    .from(rotation)
    .where(eq(rotation.organizationId, organizationId))
    .orderBy(desc(rotation.createdAt))
    .limit(1);
  if (!row) return null;
  return serializeJournalRow(row);
}

async function loadBlockingCaRotation(
  db: Db,
  organizationId: string,
): Promise<CaRotationJournalRow | null> {
  const [row] = await db
    .select()
    .from(rotation)
    .where(
      and(
        eq(rotation.organizationId, organizationId),
        inArray(rotation.state, [...CA_ROTATION_BLOCKING_STATES]),
      ),
    )
    .orderBy(desc(rotation.startedAt))
    .limit(1);
  if (!row) return null;
  return serializeJournalRow(row);
}

async function insertInProgressRotation(
  db: Db,
  organizationId: string,
  nowMs: number,
): Promise<CaRotationJournalRow | null> {
  const startedAt = nowIso(nowMs);
  const inserted = await db
    .insert(rotation)
    .values({
      organizationId,
      state: "in_progress",
      startedAt,
      results: [],
    })
    .onConflictDoNothing({
      target: rotation.organizationId,
      where: sql`${rotation.state} = 'in_progress'`,
    })
    .returning();
  const row = inserted[0];
  if (!row) return null;
  return serializeJournalRow(row);
}

/**
 * True when this journal already minted generation N+1 and fan-out may resume
 * instead of inserting another Organization CA.
 */
export function caRotationHasMintedGeneration(
  journal: CaRotationJournalRow,
): boolean {
  return journal.toCaGeneration > 0;
}

async function stealStaleInProgressRotation(
  db: Db,
  existing: CaRotationJournalRow,
  nowMs: number,
): Promise<CaRotationJournalRow | null> {
  const startedAt = nowIso(nowMs);
  // Preserve results / metadata / generations so crash recovery resumes the
  // in-flight journal instead of minting another Organization CA generation.
  const stolen = await db
    .update(rotation)
    .set({
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
    })
    .where(
      and(
        eq(rotation.id, existing.id),
        eq(rotation.state, "in_progress"),
        eq(rotation.startedAt, existing.startedAt),
      ),
    )
    .returning();
  const row = stolen[0];
  if (!row) return null;
  return serializeJournalRow(row);
}

/**
 * Begin or resume an Organization CA rotation. Returns `null` when another
 * rotation is `awaiting_retire`, or `in_progress` without a minted generation
 * and not yet stale (mint still in flight on another isolate).
 *
 * An `in_progress` row that already minted `toCaGeneration` is returned so
 * `POST /tls/ca/rotate` can continue fan-out from the stored cursor.
 */
export async function tryBeginCaRotation(
  db: Db,
  organizationId: string,
  nowMs = Date.now(),
): Promise<CaRotationJournalRow | null> {
  const blocking = await loadBlockingCaRotation(db, organizationId);
  if (blocking) {
    if (blocking.state === "awaiting_retire") return null;
    if (caRotationHasMintedGeneration(blocking)) return blocking;
    if (!journalIsStale(blocking.startedAt, nowMs)) return null;
    return stealStaleInProgressRotation(db, blocking, nowMs);
  }
  return insertInProgressRotation(db, organizationId, nowMs);
}

export async function updateCaRotationJournal(
  db: Db,
  rotationId: string,
  patch: {
    state?: CaRotationState;
    fromCaGeneration?: number;
    toCaGeneration?: number;
    results?: unknown;
    metadata?: unknown;
    completedAt?: string | null;
  },
): Promise<CaRotationJournalRow | null> {
  const updatedAt = nowIso();
  const [row] = await db
    .update(rotation)
    .set({
      updatedAt,
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.fromCaGeneration === undefined
        ? {}
        : { fromCaGeneration: patch.fromCaGeneration }),
      ...(patch.toCaGeneration === undefined
        ? {}
        : { toCaGeneration: patch.toCaGeneration }),
      ...(patch.results === undefined ? {} : { results: patch.results }),
      ...(patch.metadata === undefined ? {} : { metadata: patch.metadata }),
      ...(patch.completedAt === undefined
        ? {}
        : { completedAt: patch.completedAt }),
    })
    .where(eq(rotation.id, rotationId))
    .returning();
  if (!row) return null;
  return serializeJournalRow(row);
}
