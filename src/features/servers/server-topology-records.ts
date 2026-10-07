/**
 * The latest hardware facts each server's daemon reported (`hardware` table,
 * see `../../db/schema.ts`): one row per server, overwritten when the
 * daemon's fire-and-forget `topology-report` cell message lands (see
 * `../../daemon/cell/protocol.ts`). The table lives in the control plane's
 * Postgres in every deployment (the hosted Workers and the self-hosted Deno
 * process alike); DuckDB is only the metrics sample store, so the Postgres
 * statements here need no DuckDB twin.
 *
 * There is no history. Every stored metrics row names its own devices (blob6
 * on hosted, per-device rows on DuckDB), so an old sample never needs the
 * layout that was active when it was recorded. Sizes (RAM, CPU, disk) are
 * carried on every sample. The record answers "what hardware does this server
 * have now" (NIC names, layout paths, machine class) and lets ingest notice a
 * sample whose generation the record has not seen yet.
 *
 * Nothing a host operator or a daemon sends can make the table grow, and the
 * limits hold whatever the daemon says:
 *
 * - `generation` and `bootGeneration` fit the column ({@link MAX_TOPOLOGY_GENERATION});
 *   the snapshot is at most 64 KiB (`validateDaemonInboundFrame`, before any
 *   write, on both the Workers and the Deno path).
 * - a changed report overwrites the row at most once per server every
 *   {@link TOPOLOGY_REWRITE_COOLDOWN_SECONDS} seconds. A change refused inside
 *   that window stamps `server.metadata.topologyChurnLimitedAt` as an alert
 *   (a flapping device, a tampered daemon) and is dropped; the daemon reports
 *   again on its next change or resync.
 *
 * Every report runs under a lock on the server's row, so two reports for one
 * server are handled one after the other.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { serverHardware } from '../../db/schema.ts'
import type { TopologyLayoutPaths } from '../../contracts/topology-types.ts'

/** Largest generation number the table stores (a Postgres `integer`). */
export const MAX_TOPOLOGY_GENERATION = 2_147_483_647
/** Minimum seconds between two overwrites of one server's hardware facts. */
export const TOPOLOGY_REWRITE_COOLDOWN_SECONDS = 300
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

function serializeRow(row: typeof serverHardware.$inferSelect): TopologyGenerationRecord {
  return {
    generation: row.generation,
    bootGeneration: row.bootGeneration,
    snapshot: row.snapshot,
    appliedAt: row.appliedAt,
  }
}

export type RecordTopologyGenerationOutcome =
  /** The server's first report: its hardware row was created. */
  | 'recorded'
  /** A changed report overwrote the server's hardware row. */
  | 'refreshed'
  /** Nothing to do: the report matches the stored facts. */
  | 'unchanged'
  /** A changed report arrived inside the cooldown; nothing was written. */
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
      ? `topology report dropped for server ${serverId}: its hardware facts changed again within ${TOPOLOGY_REWRITE_COOLDOWN_SECONDS} s`
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

type ExistingHardwareRow = {
  same: boolean
  recently_written: boolean
}

/**
 * Store one topology report as the server's latest hardware facts, within the
 * limits in the module doc, under a lock on the server's row (`FOR UPDATE`,
 * the same pattern as `capability-plan-records.ts`).
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
      SELECT (h.generation = ${report.generation}
              AND h.boot_generation = ${report.bootGeneration}
              AND h.snapshot IS NOT DISTINCT FROM ${snapshotJson}::jsonb) AS same,
             (h.updated_at > now() - make_interval(secs => ${TOPOLOGY_REWRITE_COOLDOWN_SECONDS})) AS recently_written
      FROM hardware h
      WHERE h.server_id = ${serverId}::uuid
    `)) as unknown as ExistingHardwareRow[]

    const row = existing[0]
    if (!row) {
      await tx.execute(sql`
        INSERT INTO hardware (server_id, generation, boot_generation, snapshot, applied_at)
        VALUES (${serverId}::uuid, ${report.generation}::int, ${report.bootGeneration}::int,
                ${snapshotJson}::jsonb, ${report.appliedAt}::timestamptz)
      `)
      return 'recorded'
    }
    if (row.same) return 'unchanged'
    if (row.recently_written) {
      await markTopologyChurnLimited(tx, serverId)
      return 'rate_limited'
    }
    await tx.execute(sql`
      UPDATE hardware
      SET generation = ${report.generation}::int,
          boot_generation = ${report.bootGeneration}::int,
          snapshot = ${snapshotJson}::jsonb,
          applied_at = ${report.appliedAt}::timestamptz,
          updated_at = now()
      WHERE server_id = ${serverId}::uuid
    `)
    await clearTopologyChurnLimited(tx, serverId)
    return 'refreshed'
  })

  if (outcome === 'rate_limited') logTopologyChurn(serverId, 'rate_limited')
  return outcome
}

/**
 * Stamp `server.metadata.topologyChurnLimitedAt`: the durable alert that this
 * server's hardware facts changed more often than the cooldown allows (a
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

/** A report was stored, so the alert stamp is cleared. */
async function clearTopologyChurnLimited(db: Tx, serverId: string): Promise<void> {
  await db.execute(sql`
    UPDATE server
    SET metadata = metadata - 'topologyChurnLimitedAt'
    WHERE id = ${serverId}::uuid AND metadata ? 'topologyChurnLimitedAt'
  `)
}

/** How long a refused report suppresses the resync request: until the cooldown has passed. */
export const TOPOLOGY_CHURN_HOLD_MS = TOPOLOGY_REWRITE_COOLDOWN_SECONDS * 1000

/** `true` while a recent refusal says the server is changing its hardware facts too often. */
export function topologyChurnLimitedRecently(serverMetadata: unknown, nowMs = Date.now()): boolean {
  if (typeof serverMetadata !== 'object' || serverMetadata === null) return false
  const at = (serverMetadata as Record<string, unknown>).topologyChurnLimitedAt
  if (typeof at !== 'string') return false
  const stampedMs = Date.parse(at)
  return Number.isFinite(stampedMs) && nowMs - stampedMs < TOPOLOGY_CHURN_HOLD_MS
}

/** The server's latest hardware facts, or `undefined` if it has not reported any yet. */
export async function getLatestTopologyGeneration(
  db: Db,
  serverId: string
): Promise<TopologyGenerationRecord | undefined> {
  const rows = await db
    .select()
    .from(serverHardware)
    .where(eq(serverHardware.serverId, serverId))
    .limit(1)
  const row = rows[0]
  return row ? serializeRow(row) : undefined
}

/**
 * Latest hardware facts for each of `serverIds`, in one query —
 * the batched analogue of {@link getLatestTopologyGeneration} for routes that
 * must stay O(1) in the number of servers (e.g. `/servers/metrics/latest`'s
 * fleet snapshot — see `AGENTS.md`'s fleet-read invariant). A server with no
 * report yet is simply absent from the returned map rather than
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
    SELECT server_id, generation, boot_generation, snapshot, applied_at
    FROM hardware
    WHERE server_id IN (${idList})
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
 * sample's `metadata.topologyGeneration` differs from the server's stored
 * hardware facts (see {@link recordTopologyGeneration}). Ingest must never wake the Durable
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
 * query over the hardware table; servers with no topology
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
