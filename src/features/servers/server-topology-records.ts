/**
 * Bounded history of daemon-reported topology generations
 * (`topologyGeneration` table, see `../../db/schema.ts`) — one row per
 * `(server, generation)`, written when the daemon's fire-and-forget
 * `topology-report` cell message lands (see `../../daemon/cell/protocol.ts`).
 *
 * The history answers "what did this server's topology look like at
 * generation N" so a sample can be read against the entity layout (which NIC
 * was NIC 1, which drive sat in slot 2) that was active when it was recorded.
 * It is NOT a record of the machine: sizes (RAM, CPU, disk) are not history
 * here, and nothing a host operator or a daemon sends can make the table grow
 * without bound. Three limits hold whatever the daemon says:
 *
 * - `generation` and `bootGeneration` are integers that fit the column
 *   ({@link MAX_TOPOLOGY_GENERATION}); the cell protocol rejects the rest.
 * - at most {@link MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR} new generations are
 *   recorded per server per hour; the rest are dropped, counted, and logged as
 *   an alert (`server.metadata.topologyChurnLimitedAt` is stamped).
 * - only the newest {@link MAX_RETAINED_TOPOLOGY_GENERATIONS} rows are kept per
 *   server; older rows are deleted as new ones arrive.
 *
 * "Newest" is by insertion time, never by the daemon's own generation number:
 * a forged huge number must not pin itself as the latest topology.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { topologyGeneration } from '../../db/schema.ts'
import type { TopologyLayoutPaths } from '../../contracts/topology-types.ts'

/** Largest generation number the table stores (a Postgres `integer`). */
export const MAX_TOPOLOGY_GENERATION = 2_147_483_647
/** New generations recorded per server per rolling hour; honest hardware changes are rare. */
export const MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR = 12
/** Generation rows kept per server; older rows are deleted as new ones arrive. */
export const MAX_RETAINED_TOPOLOGY_GENERATIONS = 100

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
  /** The generation was already recorded; its snapshot was refreshed in place (no new row). */
  | 'refreshed'
  /** The server hit its hourly limit of new generations; nothing was written. */
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
      ? `topology generation limit reached for server ${serverId}: more than ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR} new generations in an hour; further reports are dropped`
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

/**
 * Record one topology generation, within the limits in the module doc.
 * Safe against the daemon resending a generation on reconnect —
 * `(server_id, generation)` is unique, so a repeat refreshes that row's
 * snapshot in place (the newest snapshot of a generation wins) instead of
 * adding a row. Only a genuinely new generation counts against the hourly
 * limit; the guard and the insert are one statement, so concurrent reports
 * cannot slip past it together.
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

  const existing = await db
    .update(topologyGeneration)
    .set({
      bootGeneration: report.bootGeneration,
      snapshot: report.snapshot,
      appliedAt: report.appliedAt,
    })
    .where(
      and(
        eq(topologyGeneration.serverId, serverId),
        eq(topologyGeneration.generation, report.generation),
        // An identical resend rewrites nothing.
        sql`${topologyGeneration.snapshot} IS DISTINCT FROM ${JSON.stringify(report.snapshot)}::jsonb`
      )
    )
    .returning({ id: topologyGeneration.id })
  if (existing.length > 0) return 'refreshed'

  const inserted = (await db.execute(sql`
    INSERT INTO generation (server_id, generation, boot_generation, snapshot, applied_at)
    SELECT ${serverId}::uuid, ${report.generation}, ${report.bootGeneration},
           ${JSON.stringify(report.snapshot)}::jsonb, ${report.appliedAt}::timestamptz
    WHERE (
      SELECT count(*) FROM generation
      WHERE server_id = ${serverId}::uuid AND created_at > now() - interval '1 hour'
    ) < ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR}
    ON CONFLICT (server_id, generation) DO NOTHING
    RETURNING id
  `)) as unknown as Array<{ id: string }>

  if (inserted.length === 0) {
    // Either a concurrent report recorded this generation first, or the limit was hit.
    const concurrent = await getTopologyGeneration(db, serverId, report.generation)
    if (concurrent) return 'refreshed'
    logTopologyChurn(serverId, 'rate_limited')
    await markTopologyChurnLimited(db, serverId)
    return 'rate_limited'
  }

  await pruneTopologyGenerations(db, serverId)
  return 'recorded'
}

/** Delete all but the newest {@link MAX_RETAINED_TOPOLOGY_GENERATIONS} rows of a server (by insertion time). */
export async function pruneTopologyGenerations(db: Db, serverId: string): Promise<void> {
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
 * server tried to mint more topology generations than the hourly limit allows
 * (a flapping device, a tampered daemon). `jsonb_set` on the one key, like
 * {@link markTopologyResyncRequested}, so a concurrent write to another
 * `metadata` field is never stomped.
 */
export async function markTopologyChurnLimited(db: Db, serverId: string): Promise<void> {
  await db.execute(sql`
    UPDATE server
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{topologyChurnLimitedAt}',
      ${JSON.stringify(new Date().toISOString())}::jsonb
    )
    WHERE id = ${serverId}::uuid
  `)
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

/**
 * Several historical generations at once, keyed by generation number.
 *
 * This is the "what did this server's topology look like at generation N"
 * lookup this table exists for (see the module doc comment). A metrics range
 * can span a RAM upgrade or a volume resize, and capacity totals are the
 * denominator of every derived percentage — resolving them from the *latest*
 * generation would silently restate history against today's hardware.
 *
 * Generations absent from the table are simply missing from the map; callers
 * fall back to the latest context rather than failing the query, since a
 * server that reported metrics before its first `topology-report` landed has
 * samples with no recorded generation at all.
 */
export async function getTopologyGenerations(
  db: Db,
  serverId: string,
  generations: readonly number[]
): Promise<Map<number, TopologyGenerationRecord>> {
  const wanted = [
    ...new Set(
      generations.filter((g) => Number.isInteger(g) && g >= 0 && g <= MAX_TOPOLOGY_GENERATION)
    ),
  ].slice(-MAX_RETAINED_TOPOLOGY_GENERATIONS)
  if (wanted.length === 0) return new Map()
  const rows = await db
    .select()
    .from(topologyGeneration)
    .where(
      and(eq(topologyGeneration.serverId, serverId), inArray(topologyGeneration.generation, wanted))
    )
  return new Map(rows.map((row) => [row.generation, serializeRow(row)]))
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
