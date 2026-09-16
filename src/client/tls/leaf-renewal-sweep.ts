/**
 * Organization-CA leaf renewal sweep.
 *
 * Scans `leaf` expiry-ordered (org-agnostic, keyset cursor, never OFFSET)
 * and re-enqueues the existing `managed.apply` / `managed.ingress.reconcile`
 * paths so leaves are reminted. Concurrent Workers isolates / Deno ticks
 * share a `lease`-table CAS lease (`LEAF_RENEWAL_SWEEP_LOCK`, promoted out
 * of `setting` — schema-child-tables, Road-to-0.1.x) that also stores the
 * last processed keyset cursor so a later tick can resume past
 * permanently-failing earliest rows. The steal CAS compares `cursor`
 * alongside `owner` / `expiresAt` — a concurrent cursor save between this
 * tick's read and its steal attempt must be caught, not silently missed.
 */
import { and, asc, count, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import type { DerivedSecretsConfig, SecretsConfig } from "../authn/secrets.ts";
import type { Db } from "../../db.ts";
import type { CommandQueue } from "../../lib/commands/queue.ts";
import { leaf, lease, tls } from "../../lib/db/schema.ts";
import { ORGANIZATION_CA_LEAF_VALID_DAYS } from "../../lib/tls/self-signed.ts";
import { enqueueManagedIngressReconcile } from "../managed/ingress-desired.ts";
import { enqueueApplyForManagedCluster } from "./changeover-fanout.ts";

const MS_PER_DAY = 86_400_000;

/** Max due rows processed per tick (each may enqueue apply / ingress). */
export const LEAF_RENEWAL_BATCH_SIZE = 10;

/** `setting.key` for the cross-isolate leaf-renewal sweep lease. */
export const LEAF_RENEWAL_SWEEP_LOCK_KEY = "LEAF_RENEWAL_SWEEP_LOCK";

/** Lease TTL so a crashed isolate cannot block sweeps indefinitely. */
export const LEAF_RENEWAL_SWEEP_LEASE_MS = 120_000;

/**
 * Deno-side cadence. 90-day leaves do not need a 60s tick; Workers still
 * piggybacks the existing cron and relies on the lease.
 */
export const LEAF_RENEWAL_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Remaining lifetime below which a 90-day leaf is due (lifetime / 3). */
export const LEAF_RENEWAL_REMAINING_MS =
  (ORGANIZATION_CA_LEAF_VALID_DAYS * MS_PER_DAY) / 3;

export type LeafRenewalSweepLock = Readonly<{
  owner: string;
  cursor: LeafRenewalCursor | null;
  expiresAt: string;
}>;

export type LeafRenewalCursor = {
  notAfter: string;
  id: string;
};

export type LeafRenewalSweepResult = {
  scanned: number;
  enqueued: number;
  failed: number;
  cursor: LeafRenewalCursor | null;
  completed: boolean;
};

export type DueTlsLeafRow = {
  id: string;
  organizationId: string;
  serverId: string;
  kind: string;
  managedId: string | null;
  replicaId: string | null;
  caGeneration: number;
  notAfter: string;
};

export type LeafRenewalSweepDeps = Readonly<{
  secretsConfig: SecretsConfig;
  dataEncryptionSecrets: DerivedSecretsConfig;
}>;

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function leafRenewalDeadlineIso(nowMs = Date.now()): string {
  return new Date(nowMs + LEAF_RENEWAL_REMAINING_MS).toISOString();
}

export function isTlsLeafDue(params: {
  notAfterIso: string;
  caGeneration: number;
  activeCaGeneration: number;
  nowMs?: number;
}): boolean {
  const nowMs = params.nowMs ?? Date.now();
  if (params.caGeneration !== params.activeCaGeneration) return true;
  return params.notAfterIso < leafRenewalDeadlineIso(nowMs);
}

function isLeafRenewalCursor(value: unknown): value is LeafRenewalCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.notAfter === "string" &&
    record.notAfter.length > 0 &&
    typeof record.id === "string" &&
    record.id.length > 0;
}

function persistedCursorFromResult(
  result: LeafRenewalSweepResult,
): LeafRenewalCursor | null {
  if (result.completed) return null;
  return isLeafRenewalCursor(result.cursor) ? result.cursor : null;
}

function cursorFromColumn(value: unknown): LeafRenewalCursor | null {
  return isLeafRenewalCursor(value) ? value : null;
}

function sweepLockIsExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return true;
  return expires <= nowMs;
}

function sweepLockIsStealable(
  owner: string,
  expiresAt: string,
  nowMs = Date.now(),
): boolean {
  if (owner.length === 0) return true;
  return sweepLockIsExpired(expiresAt, nowMs);
}

/**
 * The steal CAS predicate — `owner`, `expiresAt`, and `cursor` must all still
 * match what was read, matching the old `eq(setting.value, existing.value)`
 * whole-JSON compare exactly. A predicate over `owner` / `expiresAt` alone
 * would silently miss a concurrent cursor save between the read and the
 * steal attempt, widening the race this lease exists to close.
 */
function leaseCursorCondition(cursor: LeafRenewalCursor | null) {
  return cursor === null ? isNull(lease.cursor) : eq(lease.cursor, cursor);
}

/**
 * Acquire the durable sweep lease. Returns `null` when another owner holds an
 * unexpired lease. Callers that receive a lock **must** call
 * {@link endLeafRenewalSweep} in `finally`. Preserves the stored cursor
 * across steal / re-acquire so later due rows can progress.
 */
export async function tryBeginLeafRenewalSweep(
  db: Db,
  nowMs = Date.now(),
): Promise<LeafRenewalSweepLock | null> {
  const owner = crypto.randomUUID();
  const freshExpiresAt = new Date(nowMs + LEAF_RENEWAL_SWEEP_LEASE_MS)
    .toISOString();

  const inserted = await db
    .insert(lease)
    .values({
      name: LEAF_RENEWAL_SWEEP_LOCK_KEY,
      organizationId: null,
      owner,
      expiresAt: freshExpiresAt,
      cursor: null,
    })
    .onConflictDoNothing({ target: [lease.name, lease.organizationId] })
    .returning({ id: lease.id });
  if (inserted.length > 0) {
    return { owner, expiresAt: freshExpiresAt, cursor: null };
  }

  const [existing] = await db
    .select({
      owner: lease.owner,
      expiresAt: lease.expiresAt,
      cursor: lease.cursor,
    })
    .from(lease)
    .where(
      and(eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY), isNull(lease.organizationId)),
    )
    .limit(1);
  if (
    !existing || !sweepLockIsStealable(existing.owner, existing.expiresAt, nowMs)
  ) {
    return null;
  }

  const existingCursor = cursorFromColumn(existing.cursor);
  const stolenExpiresAt = new Date(nowMs + LEAF_RENEWAL_SWEEP_LEASE_MS)
    .toISOString();
  const stolen = await db
    .update(lease)
    .set({ owner, expiresAt: stolenExpiresAt, updatedAt: nowIso(nowMs) })
    .where(
      and(
        eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, existing.owner),
        eq(lease.expiresAt, existing.expiresAt),
        leaseCursorCondition(existingCursor),
      ),
    )
    .returning({ id: lease.id });
  if (stolen.length > 0) {
    return { owner, expiresAt: stolenExpiresAt, cursor: existingCursor };
  }
  return null;
}

/**
 * Persist the last processed keyset cursor onto the held lock row. Does not
 * release the lease. `null` resets the cursor (sweep completed or invalid).
 * Owner-scoped only, matching the original: this write does not re-check
 * `expiresAt`, since only the holding owner is expected to call it.
 */
export async function saveLeafRenewalSweepCursor(
  db: Db,
  lock: LeafRenewalSweepLock,
  cursor: LeafRenewalCursor | null,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .update(lease)
    .set({ cursor, updatedAt: nowIso(nowMs) })
    .where(
      and(
        eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, lock.owner),
      ),
    );
}

/**
 * Release the lease without dropping the row, so the stored cursor survives
 * until the next tick. Empty owner + expired `expiresAt` makes the row
 * stealable immediately.
 */
export async function endLeafRenewalSweep(
  db: Db,
  lock: LeafRenewalSweepLock,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .update(lease)
    .set({
      owner: "",
      expiresAt: nowIso(nowMs),
      cursor: lock.cursor,
      updatedAt: nowIso(nowMs),
    })
    .where(
      and(
        eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, lock.owner),
      ),
    );
}

/** Test-only: drop the durable sweep lock row when `db` is provided. */
export async function resetLeafRenewalSweepLockForTests(db?: Db): Promise<void> {
  if (!db) return;
  await db
    .delete(lease)
    .where(
      and(eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY), isNull(lease.organizationId)),
    );
}

function leafRenewalKeysetCondition(cursor: LeafRenewalCursor) {
  return or(
    gt(leaf.notAfter, cursor.notAfter),
    and(eq(leaf.notAfter, cursor.notAfter), gt(leaf.id, cursor.id)),
  );
}

function dueLeafPredicate(deadlineIso: string) {
  return or(
    lt(leaf.notAfter, deadlineIso),
    sql`${leaf.caGeneration} IS DISTINCT FROM ${tls.caGeneration}`,
  );
}

/**
 * Org-agnostic due-leaf page. Ordered by `notAfter` then `id`; keyset only —
 * never OFFSET. Independent of organization count.
 */
export async function loadDueTlsLeaves(
  db: Db,
  params: {
    nowMs?: number;
    cursor?: LeafRenewalCursor | null;
    limit?: number;
  } = {},
): Promise<DueTlsLeafRow[]> {
  const deadlineIso = leafRenewalDeadlineIso(params.nowMs);
  const limit = params.limit ?? LEAF_RENEWAL_BATCH_SIZE;
  const due = dueLeafPredicate(deadlineIso);
  const whereClause = params.cursor
    ? and(due, leafRenewalKeysetCondition(params.cursor))
    : due;

  return await db
    .select({
      id: leaf.id,
      organizationId: leaf.organizationId,
      serverId: leaf.serverId,
      kind: leaf.kind,
      managedId: leaf.managedId,
      replicaId: leaf.replicaId,
      caGeneration: leaf.caGeneration,
      notAfter: leaf.notAfter,
    })
    .from(leaf)
    .leftJoin(
      tls,
      and(
        eq(tls.organizationId, leaf.organizationId),
        eq(tls.source, "organization_ca"),
        eq(tls.caState, "active"),
      ),
    )
    .where(whereClause)
    .orderBy(asc(leaf.notAfter), asc(leaf.id))
    .limit(limit);
}

/** Single indexed per-org COUNT for `GET /tls/ca` `leafHealth.dueCount`. */
export async function countDueTlsLeavesForOrganization(
  db: Db,
  organizationId: string,
  params: {
    activeCaGeneration: number;
    nowMs?: number;
  },
): Promise<number> {
  const deadlineIso = leafRenewalDeadlineIso(params.nowMs);
  const [row] = await db
    .select({ dueCount: count() })
    .from(leaf)
    .where(
      and(
        eq(leaf.organizationId, organizationId),
        or(
          lt(leaf.notAfter, deadlineIso),
          sql`${leaf.caGeneration} IS DISTINCT FROM ${params.activeCaGeneration}`,
        ),
      ),
    );
  return Number(row?.dueCount ?? 0);
}

function leafRenewalContext(deps: LeafRenewalSweepDeps): Context<AppEnv> {
  return {
    get(key: string) {
      if (key === "secretsConfig") return deps.secretsConfig;
      if (key === "dataEncryptionSecrets") return deps.dataEncryptionSecrets;
      return undefined;
    },
    json(body: unknown, status?: number) {
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as Context<AppEnv>;
}

function cursorFromRow(row: DueTlsLeafRow): LeafRenewalCursor {
  return { notAfter: row.notAfter, id: row.id };
}

async function enqueueDueIngress(
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  row: DueTlsLeafRow,
): Promise<"enqueued" | "failed" | "skipped"> {
  const result = await enqueueManagedIngressReconcile(db, commandQueue, {
    serverId: row.serverId,
    actorType: "system",
    actorId: row.serverId,
    secretsConfig: deps.secretsConfig,
    dataEncryptionSecrets: deps.dataEncryptionSecrets,
  });
  if (result.ok) return "enqueued";
  if (result.reason === "not_needed") return "skipped";
  return "failed";
}

async function enqueueDueEngine(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  row: DueTlsLeafRow,
): Promise<"enqueued" | "failed"> {
  if (!row.managedId) return "failed";
  const applyRows = await enqueueApplyForManagedCluster(c, db, commandQueue, {
    actorId: row.serverId,
    organizationId: row.organizationId,
    managedId: row.managedId,
  });
  if (applyRows.some((entry) => entry.status === "failed")) return "failed";
  return "enqueued";
}

/**
 * Process one bounded due-leaf page. Callers own the durable lease.
 */
export async function renewDueTlsLeaves(
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  options: {
    cursor?: LeafRenewalCursor | null;
    limit?: number;
    nowMs?: number;
  } = {},
): Promise<LeafRenewalSweepResult> {
  const limit = options.limit ?? LEAF_RENEWAL_BATCH_SIZE;
  const rows = await loadDueTlsLeaves(db, {
    nowMs: options.nowMs,
    cursor: options.cursor,
    limit,
  });
  const summary: LeafRenewalSweepResult = {
    scanned: rows.length,
    enqueued: 0,
    failed: 0,
    cursor: rows.length > 0 ? cursorFromRow(rows.at(-1)!) : null,
    completed: rows.length < limit,
  };
  const seenIngress = new Set<string>();
  const seenManaged = new Set<string>();
  const context = leafRenewalContext(deps);

  for (const row of rows) {
    const outcome = await enqueueOneDueLeaf(
      context,
      db,
      commandQueue,
      deps,
      row,
      seenIngress,
      seenManaged,
    );
    if (outcome === "enqueued") summary.enqueued += 1;
    if (outcome === "failed") summary.failed += 1;
  }
  return summary;
}

async function enqueueOneDueLeaf(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  row: DueTlsLeafRow,
  seenIngress: Set<string>,
  seenManaged: Set<string>,
): Promise<"enqueued" | "failed" | "skipped"> {
  if (row.kind === "ingress") {
    if (seenIngress.has(row.serverId)) return "skipped";
    seenIngress.add(row.serverId);
    return await enqueueDueIngress(db, commandQueue, deps, row);
  }
  if (row.kind === "engine") {
    if (!row.managedId) return "failed";
    if (seenManaged.has(row.managedId)) return "skipped";
    seenManaged.add(row.managedId);
    return await enqueueDueEngine(c, db, commandQueue, row);
  }
  return "failed";
}

export type LeafRenewalSweepTickOutcome =
  | LeafRenewalSweepResult
  | { skipped: "lease_held" };

/**
 * One scheduled tick: acquire lease (including stored cursor), run one bounded
 * batch, persist the advanced cursor, release in `finally`. Callers must pass
 * an already-open `db` (Workers cron) or a fresh client they close themselves
 * (Deno interval).
 */
export async function runLeafRenewalSweepTick(
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  options: {
    nowMs?: number;
    limit?: number;
  } = {},
): Promise<LeafRenewalSweepTickOutcome> {
  const lock = await tryBeginLeafRenewalSweep(db, options.nowMs);
  if (!lock) return { skipped: "lease_held" };
  let persistedCursor = lock.cursor;
  try {
    const cursor = isLeafRenewalCursor(lock.cursor) ? lock.cursor : null;
    const result = await renewDueTlsLeaves(db, commandQueue, deps, {
      cursor,
      limit: options.limit,
      nowMs: options.nowMs,
    });
    persistedCursor = persistedCursorFromResult(result);
    await saveLeafRenewalSweepCursor(
      db,
      lock,
      persistedCursor,
      options.nowMs,
    );
    return result;
  } finally {
    await endLeafRenewalSweep(db, {
      ...lock,
      cursor: persistedCursor,
    }, options.nowMs);
  }
}
