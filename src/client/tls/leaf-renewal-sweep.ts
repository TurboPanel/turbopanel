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
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { leaf, lease, server, tls } from '../../db/schema.ts'
import { ORGANIZATION_CA_LEAF_VALID_DAYS } from '../../lib/tls/self-signed.ts'
import { enqueueManagedIngressReconcile } from '../../features/managed/ingress-desired.ts'
import { enqueueApplyForManagedCluster } from './changeover-fanout.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { systemRotationContext } from './system-context.ts'
import { retireOverdueRotations } from './rotation-retire.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import {
  clipLeafText,
  LEAF_STALE_NOT_NEEDED,
  leafStaleOfflineReason,
  type LeafStaleCause,
  serverOfflineTooLong,
} from '../../features/tls/leaf-vocabulary.ts'

const MS_PER_DAY = 86_400_000

/** Max due rows processed per tick (each may enqueue apply / ingress). */
export const LEAF_RENEWAL_BATCH_SIZE = 10

/** `setting.key` for the cross-isolate leaf-renewal sweep lease. */
export const LEAF_RENEWAL_SWEEP_LOCK_KEY = 'LEAF_RENEWAL_SWEEP_LOCK'

/** Lease TTL so a crashed isolate cannot block sweeps indefinitely. */
export const LEAF_RENEWAL_SWEEP_LEASE_MS = 120_000

/**
 * Deno-side cadence. 90-day leaves do not need a 60s tick; Workers still
 * piggybacks the existing cron and relies on the lease.
 */
export const LEAF_RENEWAL_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** Remaining lifetime below which a 90-day leaf is due (lifetime / 3). */
export const LEAF_RENEWAL_REMAINING_MS = (ORGANIZATION_CA_LEAF_VALID_DAYS * MS_PER_DAY) / 3

export type LeafRenewalSweepLock = Readonly<{
  owner: string
  cursor: LeafRenewalCursor | null
  expiresAt: string
}>

export type LeafRenewalCursor = {
  notAfter: string
  id: string
}

export type LeafRenewalSweepResult = {
  scanned: number
  enqueued: number
  failed: number
  /** Leaves marked stale by this pass (offline for weeks, or nothing uses them). */
  stale: number
  cursor: LeafRenewalCursor | null
  completed: boolean
}

export type DueTlsLeafRow = {
  id: string
  organizationId: string
  serverId: string
  kind: string
  managedId: string | null
  replicaId: string | null
  caGeneration: number
  notAfter: string
  attempts: number
  serverConnected: boolean | null
  serverStatusChangedAt: string | null
}

export type LeafRenewalSweepDeps = Readonly<{
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}>

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString()
}

export function leafRenewalDeadlineIso(nowMs = Date.now()): string {
  return new Date(nowMs + LEAF_RENEWAL_REMAINING_MS).toISOString()
}

export function isTlsLeafDue(params: {
  notAfterIso: string
  caGeneration: number
  activeCaGeneration: number
  nowMs?: number
}): boolean {
  const nowMs = params.nowMs ?? Date.now()
  if (params.caGeneration !== params.activeCaGeneration) return true
  return params.notAfterIso < leafRenewalDeadlineIso(nowMs)
}

function isLeafRenewalCursor(value: unknown): value is LeafRenewalCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.notAfter === 'string' &&
    record.notAfter.length > 0 &&
    typeof record.id === 'string' &&
    record.id.length > 0
  )
}

function persistedCursorFromResult(result: LeafRenewalSweepResult): LeafRenewalCursor | null {
  if (result.completed) return null
  return isLeafRenewalCursor(result.cursor) ? result.cursor : null
}

function cursorFromColumn(value: unknown): LeafRenewalCursor | null {
  return isLeafRenewalCursor(value) ? value : null
}

function sweepLockIsExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const expires = Date.parse(expiresAt)
  if (!Number.isFinite(expires)) return true
  return expires <= nowMs
}

function sweepLockIsStealable(owner: string, expiresAt: string, nowMs = Date.now()): boolean {
  if (owner.length === 0) return true
  return sweepLockIsExpired(expiresAt, nowMs)
}

/**
 * The steal CAS predicate — `owner`, `expiresAt`, and `cursor` must all still
 * match what was read, matching the old `eq(setting.value, existing.value)`
 * whole-JSON compare exactly. A predicate over `owner` / `expiresAt` alone
 * would silently miss a concurrent cursor save between the read and the
 * steal attempt, widening the race this lease exists to close.
 */
function leaseCursorCondition(cursor: LeafRenewalCursor | null) {
  return cursor === null ? isNull(lease.cursor) : eq(lease.cursor, cursor)
}

/**
 * Acquire the durable sweep lease. Returns `null` when another owner holds an
 * unexpired lease. Callers that receive a lock **must** call
 * {@link endLeafRenewalSweep} in `finally`. Preserves the stored cursor
 * across steal / re-acquire so later due rows can progress.
 */
export async function tryBeginLeafRenewalSweep(
  db: Db,
  nowMs = Date.now()
): Promise<LeafRenewalSweepLock | null> {
  const owner = crypto.randomUUID()
  const freshExpiresAt = new Date(nowMs + LEAF_RENEWAL_SWEEP_LEASE_MS).toISOString()

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
    .returning({ id: lease.id })
  if (inserted.length > 0) {
    return { owner, expiresAt: freshExpiresAt, cursor: null }
  }

  const [existing] = await db
    .select({
      owner: lease.owner,
      expiresAt: lease.expiresAt,
      cursor: lease.cursor,
    })
    .from(lease)
    .where(and(eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY), isNull(lease.organizationId)))
    .limit(1)
  if (!existing || !sweepLockIsStealable(existing.owner, existing.expiresAt, nowMs)) {
    return null
  }

  const existingCursor = cursorFromColumn(existing.cursor)
  const stolenExpiresAt = new Date(nowMs + LEAF_RENEWAL_SWEEP_LEASE_MS).toISOString()
  const stolen = await db
    .update(lease)
    .set({ owner, expiresAt: stolenExpiresAt, updatedAt: nowIso(nowMs) })
    .where(
      and(
        eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, existing.owner),
        eq(lease.expiresAt, existing.expiresAt),
        leaseCursorCondition(existingCursor)
      )
    )
    .returning({ id: lease.id })
  if (stolen.length > 0) {
    return { owner, expiresAt: stolenExpiresAt, cursor: existingCursor }
  }
  return null
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
  nowMs = Date.now()
): Promise<void> {
  await db
    .update(lease)
    .set({ cursor, updatedAt: nowIso(nowMs) })
    .where(
      and(
        eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, lock.owner)
      )
    )
}

/**
 * Release the lease without dropping the row, so the stored cursor survives
 * until the next tick. Empty owner + expired `expiresAt` makes the row
 * stealable immediately.
 */
export async function endLeafRenewalSweep(
  db: Db,
  lock: LeafRenewalSweepLock,
  nowMs = Date.now()
): Promise<void> {
  await db
    .update(lease)
    .set({
      owner: '',
      expiresAt: nowIso(nowMs),
      cursor: lock.cursor,
      updatedAt: nowIso(nowMs),
    })
    .where(
      and(
        eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY),
        isNull(lease.organizationId),
        eq(lease.owner, lock.owner)
      )
    )
}

/** Test-only: drop the durable sweep lock row when `db` is provided. */
export async function resetLeafRenewalSweepLockForTests(db?: Db): Promise<void> {
  if (!db) return
  await db
    .delete(lease)
    .where(and(eq(lease.name, LEAF_RENEWAL_SWEEP_LOCK_KEY), isNull(lease.organizationId)))
}

function leafRenewalKeysetCondition(cursor: LeafRenewalCursor) {
  return or(
    gt(leaf.notAfter, cursor.notAfter),
    and(eq(leaf.notAfter, cursor.notAfter), gt(leaf.id, cursor.id))
  )
}

/**
 * A leaf tried before waits `30 minutes * 2^attempts` (at most a day) before
 * the sweep tries it again, so an unreachable server is not asked every tick.
 */
function leafRetryReadyPredicate(nowMs: number) {
  const nowIso = new Date(nowMs).toISOString()
  return sql`(${leaf.attemptedAt} IS NULL OR ${leaf.attemptedAt} < ${nowIso}::timestamptz - least(interval '24 hours', interval '30 minutes' * power(2, least(${leaf.attempts}, 10))))`
}

function dueLeafPredicate(deadlineIso: string) {
  return or(
    lt(leaf.notAfter, deadlineIso),
    sql`${leaf.caGeneration} IS DISTINCT FROM ${tls.caGeneration}`
  )
}

/**
 * Org-agnostic due-leaf page. Ordered by `notAfter` then `id`; keyset only —
 * never OFFSET. Independent of organization count. Stale leaves are not
 * listed, and a leaf tried recently waits out its back-off.
 */
export async function loadDueTlsLeaves(
  db: Db,
  params: {
    nowMs?: number
    cursor?: LeafRenewalCursor | null
    limit?: number
    /** Ignore the retry back-off (an owner asked for the renewal now). */
    ignoreBackoff?: boolean
  } = {}
): Promise<DueTlsLeafRow[]> {
  const nowMs = params.nowMs ?? Date.now()
  const deadlineIso = leafRenewalDeadlineIso(nowMs)
  const limit = params.limit ?? LEAF_RENEWAL_BATCH_SIZE
  const due = and(
    eq(leaf.state, 'active'),
    dueLeafPredicate(deadlineIso),
    params.ignoreBackoff ? undefined : leafRetryReadyPredicate(nowMs)
  )
  const whereClause = params.cursor ? and(due, leafRenewalKeysetCondition(params.cursor)) : due

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
      attempts: leaf.attempts,
      serverConnected: server.isConnected,
      serverStatusChangedAt: server.statusChangedAt,
    })
    .from(leaf)
    .leftJoin(
      tls,
      and(
        eq(tls.organizationId, leaf.organizationId),
        eq(tls.source, 'organization_ca'),
        eq(tls.caState, 'active')
      )
    )
    .leftJoin(server, eq(server.id, leaf.serverId))
    .where(whereClause)
    .orderBy(asc(leaf.notAfter), asc(leaf.id))
    .limit(limit)
}

/**
 * One indexed per-org pass for `GET /tls/ca` `leafHealth`: leaves that are due
 * (on an older CA generation, or close to expiry) and leaves marked stale.
 */
export async function countLeafHealthForOrganization(
  db: Db,
  organizationId: string,
  params: {
    activeCaGeneration: number
    nowMs?: number
  }
): Promise<{ dueCount: number; staleCount: number }> {
  const deadlineIso = leafRenewalDeadlineIso(params.nowMs)
  const dueSql = sql`${leaf.state} = 'active' AND (${leaf.notAfter} < ${deadlineIso}::timestamptz OR ${leaf.caGeneration} IS DISTINCT FROM ${params.activeCaGeneration})`
  const [row] = await db
    .select({
      dueCount: sql<number>`count(*) FILTER (WHERE ${dueSql})`,
      staleCount: sql<number>`count(*) FILTER (WHERE ${leaf.state} = 'stale')`,
    })
    .from(leaf)
    .where(eq(leaf.organizationId, organizationId))
  return { dueCount: Number(row?.dueCount ?? 0), staleCount: Number(row?.staleCount ?? 0) }
}

/** Single indexed per-org COUNT of leaves that still need renewal (stale ones excluded). */
export async function countDueTlsLeavesForOrganization(
  db: Db,
  organizationId: string,
  params: {
    activeCaGeneration: number
    nowMs?: number
  }
): Promise<number> {
  return (await countLeafHealthForOrganization(db, organizationId, params)).dueCount
}

function cursorFromRow(row: DueTlsLeafRow): LeafRenewalCursor {
  return { notAfter: row.notAfter, id: row.id }
}

type DueLeafOutcome =
  | { status: 'enqueued' }
  | { status: 'failed'; reason: string }
  | { status: 'skipped' }
  | { status: 'not_needed' }

async function enqueueDueIngress(
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  row: DueTlsLeafRow
): Promise<DueLeafOutcome> {
  const result = await enqueueManagedIngressReconcile(db, commandQueue, {
    serverId: row.serverId,
    actorType: 'system',
    actorId: row.serverId,
    secretsConfig: deps.secretsConfig,
    dataEncryptionSecrets: deps.dataEncryptionSecrets,
  })
  if (result.ok) return { status: 'enqueued' }
  if (result.reason === 'not_needed') return { status: 'not_needed' }
  return {
    status: 'failed',
    reason:
      result.reason === 'prepare_failed'
        ? 'The certificate settings for this server could not be prepared.'
        : 'The renewal could not be sent to the server.',
  }
}

async function enqueueDueEngine(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  row: DueTlsLeafRow
): Promise<DueLeafOutcome> {
  if (!row.managedId) {
    return { status: 'failed', reason: 'The leaf does not name its database cluster.' }
  }
  const applyRows = await enqueueApplyForManagedCluster(c, db, commandQueue, {
    actorId: row.serverId,
    organizationId: row.organizationId,
    managedId: row.managedId,
  })
  const failed = applyRows.find((entry) => entry.status === 'failed')
  if (failed) {
    return {
      status: 'failed',
      reason: `The renewal could not be queued${failed.error ? ` (${failed.error})` : ''}.`,
    }
  }
  return { status: 'enqueued' }
}

async function enqueueOneDueLeaf(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  row: DueTlsLeafRow,
  seenIngress: Set<string>,
  seenManaged: Set<string>
): Promise<DueLeafOutcome> {
  if (row.kind === 'ingress') {
    if (seenIngress.has(row.serverId)) return { status: 'skipped' }
    seenIngress.add(row.serverId)
    return await enqueueDueIngress(db, commandQueue, deps, row)
  }
  if (row.kind === 'engine') {
    if (!row.managedId) {
      return { status: 'failed', reason: 'The leaf does not name its database cluster.' }
    }
    if (seenManaged.has(row.managedId)) return { status: 'skipped' }
    seenManaged.add(row.managedId)
    return await enqueueDueEngine(c, db, commandQueue, row)
  }
  return { status: 'failed', reason: 'Unknown leaf kind.' }
}

/**
 * Mark one leaf stale so nothing waits on it: it is no longer counted or
 * renewed. `expectedAttempts` is the try count the caller saw; an owner who
 * asked for a renewal in the meantime has bumped it, and then the mark is
 * dropped instead of overriding that renewal.
 */
export async function markTlsLeafStale(
  db: Db,
  leafId: string,
  reason: string,
  cause: LeafStaleCause,
  nowMs = Date.now(),
  expectedAttempts?: number
): Promise<boolean> {
  const stamp = nowIso(nowMs)
  const rows = await db
    .update(leaf)
    .set({
      state: 'stale',
      staleAt: stamp,
      staleReason: clipLeafText(reason),
      staleCause: cause,
      updatedAt: stamp,
    })
    .where(
      and(
        eq(leaf.id, leafId),
        eq(leaf.state, 'active'),
        expectedAttempts === undefined ? undefined : eq(leaf.attempts, expectedAttempts)
      )
    )
    .returning({ id: leaf.id })
  return rows.length > 0
}

/**
 * A server that was offline for weeks and is connected again gets its stale
 * leaves back: they are active (and due, if the previous Organization CA was
 * retired meanwhile) so this tick renews them. Without it a returning server
 * would keep a certificate nothing trusts any more. Only `offline` marks come
 * back this way; `unused` and `owner` marks stay until a deploy or an owner
 * says otherwise.
 */
export async function reactivateLeavesOfReturnedServers(db: Db): Promise<number> {
  const rows = await db
    .update(leaf)
    .set({
      state: 'active',
      staleAt: null,
      staleReason: null,
      staleCause: null,
      attempts: 0,
      attemptedAt: null,
      lastError: null,
    })
    .where(
      and(
        eq(leaf.state, 'stale'),
        eq(leaf.staleCause, 'offline'),
        sql`${leaf.serverId} IN (SELECT id FROM server WHERE is_connected)`
      )
    )
    .returning({ id: leaf.id })
  return rows.length
}

/**
 * Remember that a renewal was queued (or why it could not be). An engine leaf
 * shares one apply with its siblings on the cluster, so they all wait together.
 */
async function recordLeafAttempt(
  db: Db,
  row: DueTlsLeafRow,
  lastError: string | null,
  nowMs: number
): Promise<void> {
  const stamp = nowIso(nowMs)
  const scope =
    row.kind === 'engine' && row.managedId
      ? and(eq(leaf.managedId, row.managedId), eq(leaf.organizationId, row.organizationId))
      : eq(leaf.id, row.id)
  await db
    .update(leaf)
    .set({
      attempts: sql`${leaf.attempts} + 1`,
      attemptedAt: stamp,
      lastError: lastError === null ? null : clipLeafText(lastError),
    })
    .where(and(scope, eq(leaf.state, 'active')))
}

/**
 * Renew one due leaf: stale it when its server has been gone for weeks or
 * nothing uses it, otherwise queue the existing apply / ingress reconcile and
 * remember the try.
 */
export async function renewOneTlsLeaf(
  c: Context<AppEnv>,
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  row: DueTlsLeafRow,
  seen: { ingress: Set<string>; managed: Set<string> },
  nowMs = Date.now(),
  options: { skipOfflineCheck?: boolean } = {}
): Promise<'enqueued' | 'failed' | 'skipped' | 'stale'> {
  if (
    !options.skipOfflineCheck &&
    serverOfflineTooLong({
      isConnected: row.serverConnected ?? false,
      statusChangedAt: row.serverStatusChangedAt,
      nowMs,
    })
  ) {
    await markTlsLeafStale(
      db,
      row.id,
      leafStaleOfflineReason(row.serverStatusChangedAt),
      'offline',
      nowMs,
      row.attempts
    )
    return 'stale'
  }
  const outcome = await enqueueOneDueLeaf(
    c,
    db,
    commandQueue,
    deps,
    row,
    seen.ingress,
    seen.managed
  )
  if (outcome.status === 'not_needed') {
    await markTlsLeafStale(db, row.id, LEAF_STALE_NOT_NEEDED, 'unused', nowMs, row.attempts)
    return 'stale'
  }
  if (outcome.status === 'enqueued') {
    await recordLeafAttempt(db, row, null, nowMs)
    return 'enqueued'
  }
  if (outcome.status === 'failed') {
    await recordLeafAttempt(db, row, outcome.reason, nowMs)
    return 'failed'
  }
  return 'skipped'
}

/**
 * Process one bounded due-leaf page. Callers own the durable lease.
 */
export async function renewDueTlsLeaves(
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  options: {
    cursor?: LeafRenewalCursor | null
    limit?: number
    nowMs?: number
  } = {}
): Promise<LeafRenewalSweepResult> {
  const limit = options.limit ?? LEAF_RENEWAL_BATCH_SIZE
  await reactivateLeavesOfReturnedServers(db)
  const rows = await loadDueTlsLeaves(db, {
    nowMs: options.nowMs,
    cursor: options.cursor,
    limit,
  })
  const summary: LeafRenewalSweepResult = {
    scanned: rows.length,
    enqueued: 0,
    failed: 0,
    stale: 0,
    cursor: rows.length > 0 ? cursorFromRow(rows.at(-1)!) : null,
    completed: rows.length < limit,
  }
  const seen = { ingress: new Set<string>(), managed: new Set<string>() }
  const context = systemRotationContext(deps)

  await forEachSequential(rows, async (row) => {
    const outcome = await renewOneTlsLeaf(context, db, commandQueue, deps, row, seen, options.nowMs)
    if (outcome === 'enqueued') summary.enqueued += 1
    if (outcome === 'failed') summary.failed += 1
    if (outcome === 'stale') summary.stale += 1
  })
  return summary
}

/** An overdue rotation is retired on the same lease; a failure here never fails the renewals. */
async function retireOverdueRotationsQuietly(
  db: Db,
  commandQueue: CommandQueue,
  deps: LeafRenewalSweepDeps,
  nowMs?: number
): Promise<void> {
  try {
    await retireOverdueRotations(
      db,
      {
        commandQueue,
        secretsConfig: deps.secretsConfig,
        dataEncryptionSecrets: deps.dataEncryptionSecrets,
      },
      nowMs
    )
  } catch (err) {
    compatLogWarn(
      'tls-rotation',
      `overdue rotation retire failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export type LeafRenewalSweepTickOutcome = LeafRenewalSweepResult | { skipped: 'lease_held' }

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
    nowMs?: number
    limit?: number
  } = {}
): Promise<LeafRenewalSweepTickOutcome> {
  const lock = await tryBeginLeafRenewalSweep(db, options.nowMs)
  if (!lock) return { skipped: 'lease_held' }
  let persistedCursor = lock.cursor
  try {
    const cursor = isLeafRenewalCursor(lock.cursor) ? lock.cursor : null
    const result = await renewDueTlsLeaves(db, commandQueue, deps, {
      cursor,
      limit: options.limit,
      nowMs: options.nowMs,
    })
    persistedCursor = persistedCursorFromResult(result)
    await saveLeafRenewalSweepCursor(db, lock, persistedCursor, options.nowMs)
    await retireOverdueRotationsQuietly(db, commandQueue, deps, options.nowMs)
    return result
  } finally {
    await endLeafRenewalSweep(
      db,
      {
        ...lock,
        cursor: persistedCursor,
      },
      options.nowMs
    )
  }
}
