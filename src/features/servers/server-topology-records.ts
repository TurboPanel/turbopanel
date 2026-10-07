/**
 * Bounded history of daemon-reported topology generations
 * (`topologyGeneration` table, see `../../db/schema.ts`) — one row per
 * `(server, generation)`, written when the daemon's fire-and-forget
 * `topology-report` cell message lands (see `../../daemon/cell/protocol.ts`).
 * The table lives in the control plane's Postgres in every deployment (the
 * hosted Workers and the self-hosted Deno process alike); DuckDB is only the
 * metrics sample store, so the Postgres statements here need no DuckDB twin.
 *
 * The history answers "what did this server's topology look like at
 * generation N" so a sample can be read against the entity layout (which NIC
 * was NIC 1, which drive sat in slot 2) that was active when it was recorded.
 * It is NOT a record of the machine: sizes (RAM, CPU, disk) are carried on
 * every sample and are not history here. Nothing a host operator or a daemon
 * sends can make the table grow without bound. Limits that hold whatever the
 * daemon says:
 *
 * - `generation` and `bootGeneration` fit the column ({@link MAX_TOPOLOGY_GENERATION});
 *   the snapshot is at most 64 KiB (`validateDaemonInboundFrame`, before any
 *   write, on both the Workers and the Deno path).
 * - at most {@link MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR} new generations per
 *   server per rolling hour and {@link MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY}
 *   per rolling day; the rest are dropped and `server.metadata.topologyChurnLimitedAt`
 *   is stamped as an alert. The day cap is what keeps a slow, patient flood
 *   from pushing honest rows out of the retained window.
 * - only the newest {@link MAX_RETAINED_TOPOLOGY_GENERATIONS} rows are kept per
 *   server. At the daily cap a flood needs over 8 days to evict an honest row.
 * - a resend of a recorded generation never adds a row and never rewrites an
 *   older row's snapshot; it is throttled to one write per server per
 *   {@link TOPOLOGY_REWRITE_COOLDOWN_SECONDS} seconds.
 *
 * Every report runs under a lock on the server's row, so concurrent reports
 * cannot slip past the counters together.
 *
 * "Newest" is by write time, never by the daemon's own generation number: a
 * forged huge number must not pin itself as the latest topology.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { topologyGeneration } from '../../db/schema.ts'
import type { TopologyLayoutPaths } from '../../contracts/topology-types.ts'

/** Largest generation number the table stores (a Postgres `integer`). */
export const MAX_TOPOLOGY_GENERATION = 2_147_483_647
/** New generations recorded per server per rolling hour; honest hardware changes are rare. */
export const MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR = 12
/** New generations recorded per server per rolling day. */
export const MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY = 24
/** Generation rows kept per server; older rows are deleted as new ones arrive. */
export const MAX_RETAINED_TOPOLOGY_GENERATIONS = 200
/** Minimum seconds between two rewrites (a resend of a recorded generation) for one server. */
export const TOPOLOGY_REWRITE_COOLDOWN_SECONDS = 30
/** The churn alert stamp is rewritten at most this often, so a flood cannot also write the server row every message. */
const CHURN_STAMP_REFRESH_SECONDS = 300

export type TopologyGenerationRecord = {
  generation: number
  bootGeneration: number
  snapshot: unknown
  appliedAt: string
}

/** Parameters for {@link recordTopologyGeneration} — the daemon's own report, verbatim. */
export type TopologyGenerationReport = {
  generation: number
  bootGeneration: number
  /** The daemon-reported topology object, stored as-is — never a wrapper around it. */
  snapshot: unknown
  /** The daemon's own report timestamp (`topology-report.at`) — never a control-plane receipt time. */
  appliedAt: string
}

function serializeRow(row: typeof topologyGeneration.$inferSelect): TopologyGenerationRecord {
  return {
    generation: row.generation,
    bootGeneration: row.bootGeneration,
    snapshot: row.snapshot,
    appliedAt: row.appliedAt,
  }
}

export type RecordTopologyGenerationOutcome =
  /** A new `(server, generation)` row was written. */
  | 'recorded'
  /** A resend of a recorded generation changed the stored row (newest row: snapshot; older row: it became the latest). */
  | 'refreshed'
  /** Nothing to do: an identical resend, or a rewrite inside the cooldown. */
  | 'unchanged'
  /** The server hit its hourly or daily limit of new generations; nothing was written. */
  | 'rate_limited'
  /** The numbers do not fit the table; nothing was written. */
  | 'rejected'

const CHURN_LOG_COOLDOWN_MS = 10 * 60 * 1000
const MAX_CHURN_LOG_KEYS = 1000
const churnLogAt = new Map<string, number>()

/** One alert line per server per cooldown, so a flood cannot also flood the log. */
function logTopologyChurn(serverId: string, outcome: 'rate_limited' | 'rejected'): void {
  const now = Date.now()
  const key = `${serverId}:${outcome}`
  const last = churnLogAt.get(key)
  if (last !== undefined && now - last < CHURN_LOG_COOLDOWN_MS) return
  if (churnLogAt.size >= MAX_CHURN_LOG_KEYS) {
    const oldest = churnLogAt.keys().next()
    if (!oldest.done) churnLogAt.delete(oldest.value)
  }
  churnLogAt.set(key, now)
  console.error(
    outcome === 'rate_limited'
      ? `topology generation limit reached for server ${serverId}: more than ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR} new generations in an hour or ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY} in a day; further reports are dropped`
      : `topology report rejected for server ${serverId}: generation numbers out of range`
  )
}

/** Test seam: forget the alert cooldowns. */
export function resetTopologyChurnLogForTests(): void {
  churnLogAt.clear()
}

function fitsGeneration(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TOPOLOGY_GENERATION
}

type Tx = Pick<Db, 'execute'>

type ExistingGenerationRow = {
  id: string
  newest: boolean
  same: boolean
  recently_written: boolean
}

/**
 * Record one topology generation, within the limits in the module doc, under
 * a lock on the server's row (`FOR UPDATE`, the same pattern as
 * `capability-plan-records.ts`) so two reports for one server are handled one
 * after the other and the counters below cannot be raced.
 *
 * - A generation not seen before is inserted if the hourly and daily limits
 *   allow it, then the oldest rows beyond the retention cap are deleted.
 * - A generation already recorded never adds a row. If it is the newest row its
 *   snapshot is refreshed when it differs; if it is an older row it only becomes
 *   the latest again (an honest daemon reconnecting at its current generation
 *   must not stay behind a forged newer row) and its snapshot is left alone.
 *   Either rewrite waits {@link TOPOLOGY_REWRITE_COOLDOWN_SECONDS} since the
 *   server's last write.
 */
export async function recordTopologyGeneration(
  db: Db,
  serverId: string,
  report: TopologyGenerationReport
): Promise<RecordTopologyGenerationOutcome> {
  if (!fitsGeneration(report.generation) || !fitsGeneration(report.bootGeneration)) {
    logTopologyChurn(serverId, 'rejected')
    return 'rejected'
  }
  const snapshotJson = JSON.stringify(report.snapshot ?? null)

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM server WHERE id = ${serverId}::uuid FOR UPDATE`)

    const existing = (await tx.execute(sql`
      SELECT g.id,
             (g.id = (
               SELECT id FROM generation WHERE server_id = ${serverId}::uuid
               ORDER BY created_at DESC, id DESC LIMIT 1
             )) AS newest,
             (g.snapshot IS NOT DISTINCT FROM ${snapshotJson}::jsonb) AS same,
             EXISTS (
               SELECT 1 FROM generation
               WHERE server_id = ${serverId}::uuid
                 AND created_at > now() - make_interval(secs => ${TOPOLOGY_REWRITE_COOLDOWN_SECONDS})
             ) AS recently_written
      FROM generation g
      WHERE g.server_id = ${serverId}::uuid AND g.generation = ${report.generation}
    `)) as unknown as ExistingGenerationRow[]

    const row = existing[0]
    if (row) return await rewriteExistingGeneration(tx, row, report, snapshotJson)
    return await insertNewGeneration(tx, serverId, report, snapshotJson)
  })

  if (outcome === 'rate_limited') logTopologyChurn(serverId, 'rate_limited')
  return outcome
}

async function rewriteExistingGeneration(
  tx: Tx,
  row: ExistingGenerationRow,
  report: TopologyGenerationReport,
  snapshotJson: string
): Promise<RecordTopologyGenerationOutcome> {
  if (row.recently_written) return 'unchanged'
  if (row.newest) {
    if (row.same) return 'unchanged'
    await tx.execute(sql`
      UPDATE generation
      SET snapshot = ${snapshotJson}::jsonb,
          boot_generation = ${report.bootGeneration},
          applied_at = ${report.appliedAt}::timestamptz,
          created_at = now()
      WHERE id = ${row.id}::uuid
    `)
    return 'refreshed'
  }
  // An older row: history is not rewritten, it only becomes the latest again.
  await tx.execute(sql`UPDATE generation SET created_at = now() WHERE id = ${row.id}::uuid`)
  return 'refreshed'
}

async function insertNewGeneration(
  tx: Tx,
  serverId: string,
  report: TopologyGenerationReport,
  snapshotJson: string
): Promise<RecordTopologyGenerationOutcome> {
  const inserted = (await tx.execute(sql`
    INSERT INTO generation (server_id, generation, boot_generation, snapshot, applied_at)
    SELECT ${serverId}::uuid, ${report.generation}::int, ${report.bootGeneration}::int,
           ${snapshotJson}::jsonb, ${report.appliedAt}::timestamptz
    WHERE (SELECT count(*) FROM generation
           WHERE server_id = ${serverId}::uuid AND created_at > now() - interval '1 hour')
            < ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR}
      AND (SELECT count(*) FROM generation
           WHERE server_id = ${serverId}::uuid AND created_at > now() - interval '1 day')
            < ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY}
    RETURNING id
  `)) as unknown as Array<{ id: string }>

  if (inserted.length === 0) {
    await markTopologyChurnLimited(tx, serverId)
    return 'rate_limited'
  }

  await pruneTopologyGenerations(tx, serverId)
  await clearTopologyChurnLimited(tx, serverId)
  return 'recorded'
}

/** Delete all but the newest {@link MAX_RETAINED_TOPOLOGY_GENERATIONS} rows of a server (by write time). */
export async function pruneTopologyGenerations(db: Tx, serverId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM generation
    WHERE server_id = ${serverId}::uuid
      AND id NOT IN (
        SELECT id FROM generation
        WHERE server_id = ${serverId}::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT ${MAX_RETAINED_TOPOLOGY_GENERATIONS}
      )
  `)
}

/**
 * Stamp `server.metadata.topologyChurnLimitedAt`: the durable alert that this
 * server tried to mint more topology generations than the limits allow (a
 * flapping device, a tampered daemon). `jsonb_set` on the one key, like
 * {@link markTopologyResyncRequested}, so a concurrent write to another
 * `metadata` field is never stomped. Rewritten at most every few minutes.
 */
export async function markTopologyChurnLimited(db: Tx, serverId: string): Promise<void> {
  await db.execute(sql`
    UPDATE server
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{topologyChurnLimitedAt}',
      ${JSON.stringify(new Date().toISOString())}::jsonb
    )
    WHERE id = ${serverId}::uuid
      AND (
        metadata->>'topologyChurnLimitedAt' IS NULL
        OR (metadata->>'topologyChurnLimitedAt')::timestamptz
             < now() - make_interval(secs => ${CHURN_STAMP_REFRESH_SECONDS})
      )
  `)
}

/** A report was recorded, so the limits have room again: the alert stamp is cleared. */
async function clearTopologyChurnLimited(db: Tx, serverId: string): Promise<void> {
  await db.execute(sql`
    UPDATE server
    SET metadata = metadata - 'topologyChurnLimitedAt'
    WHERE id = ${serverId}::uuid AND metadata ? 'topologyChurnLimitedAt'
  `)
}

/** How long a refused report suppresses the resync request: until the hourly window can have freed up. */
export const TOPOLOGY_CHURN_HOLD_MS = 60 * 60 * 1000

/** `true` while a recent refusal says the server is over its generation limits. */
export function topologyChurnLimitedRecently(serverMetadata: unknown, nowMs = Date.now()): boolean {
  if (typeof serverMetadata !== 'object' || serverMetadata === null) return false
  const at = (serverMetadata as Record<string, unknown>).topologyChurnLimitedAt
  if (typeof at !== 'string') return false
  const stampedMs = Date.parse(at)
  return Number.isFinite(stampedMs) && nowMs - stampedMs < TOPOLOGY_CHURN_HOLD_MS
}

/** Most recently recorded row for a server (insertion order, never the daemon's own number), or `undefined` if none has been reported yet. */
export async function getLatestTopologyGeneration(
  db: Db,
  serverId: string
): Promise<TopologyGenerationRecord | undefined> {
  const rows = await db
    .select()
    .from(topologyGeneration)
    .where(eq(topologyGeneration.serverId, serverId))
    .orderBy(desc(topologyGeneration.createdAt), desc(topologyGeneration.id))
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : undefined
}

/**
 * Most recently recorded row for each of `serverIds`, in one query —
 * the batched analogue of {@link getLatestTopologyGeneration} for routes that
 * must stay O(1) in the number of servers (e.g. `/servers/metrics/latest`'s
 * fleet snapshot — see `AGENTS.md`'s fleet-read invariant). A server with no
 * recorded generation is simply absent from the returned map rather than
 * mapped to `undefined`, so callers can use `.has()` /  `.get()` directly.
 */
export async function getLatestTopologyGenerations(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, TopologyGenerationRecord>> {
  if (serverIds.length === 0) return new Map()
  const idList = sql.join(
    serverIds.map((id) => sql`${id}::uuid`),
    sql`, `
  )
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (server_id) server_id, generation, boot_generation, snapshot, applied_at
    FROM generation
    WHERE server_id IN (${idList})
    ORDER BY server_id, created_at DESC, id DESC
  `)) as unknown as Array<{
    server_id: string
    generation: number
    boot_generation: number
    snapshot: unknown
    applied_at: string
  }>

  const out = new Map<string, TopologyGenerationRecord>()
  for (const row of rows) {
    out.set(row.server_id, {
      generation: row.generation,
      bootGeneration: row.boot_generation,
      snapshot: row.snapshot,
      appliedAt: row.applied_at,
    })
  }
  return out
}

/**
 * Stamp `server.metadata.topologyResyncRequestedAt` — the durable signal
 * that `POST /api/daemon/v1/metrics` emits (see `api-routes.ts`) when a
 * sample's `metadata.topologyGeneration` has never been recorded via
 * {@link recordTopologyGeneration}. Ingest must never wake the Durable
 * Object to ask the daemon for a fresh `topology-report` directly, so this
 * marker is the hand-off point: a later phase's sweep reads it from a safe,
 * non-DO context and pushes the actual re-sync request to the connected
 * daemon cell.
 *
 * `jsonb_set` only the one key — a full metadata read-modify-write here
 * could stomp a concurrent write to an unrelated `metadata` field from
 * another request.
 */
export async function markTopologyResyncRequested(db: Db, serverId: string): Promise<void> {
  await db.execute(sql`
    UPDATE server
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{topologyResyncRequestedAt}',
      ${JSON.stringify(new Date().toISOString())}::jsonb
    )
    WHERE id = ${serverId}::uuid
  `)
}

/** The specific historical generation row for a server, or `undefined` if it was never recorded. */
export async function getTopologyGeneration(
  db: Db,
  serverId: string,
  generation: number
): Promise<TopologyGenerationRecord | undefined> {
  const rows = await db
    .select()
    .from(topologyGeneration)
    .where(
      and(eq(topologyGeneration.serverId, serverId), eq(topologyGeneration.generation, generation))
    )
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : undefined
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The host layout paths a v6 daemon reports on its topology snapshot
 * (`snapshot.paths`), or `null` for a snapshot recorded by an older daemon
 * or a malformed one. Read-only facts: the daemon takes them from its own
 * environment (`TURBOPANEL_BACKUP_DIR`), so nothing on the control plane
 * can set them.
 */
export function layoutPathsFromSnapshot(snapshot: unknown): TopologyLayoutPaths | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null
  const paths = (snapshot as Record<string, unknown>).paths
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return null
  const { backup, logs } = paths as Record<string, unknown>
  if (!nonEmptyString(backup) || !nonEmptyString(logs)) return null
  return { backup, logs }
}

/**
 * Latest reported layout paths per server, for the server DTOs. One
 * `DISTINCT ON` query over the generation table; servers with no topology
 * yet (or a pre-v6 daemon) are simply absent from the map.
 */
export async function loadServerLayoutPaths(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, TopologyLayoutPaths>> {
  const out = new Map<string, TopologyLayoutPaths>()
  const latest = await getLatestTopologyGenerations(db, serverIds)
  for (const [serverId, record] of latest) {
    const paths = layoutPathsFromSnapshot(record.snapshot)
    if (paths) out.set(serverId, paths)
  }
  return out
}
