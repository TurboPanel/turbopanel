/**
 * The latest daemon-reported topology (`server.hardware`, see
 * `../../db/schema.ts`) — one value per server, written when the daemon's
 * fire-and-forget `topology-report` cell message lands (see
 * `../../daemon/cell/protocol.ts`). The column lives in the control plane's
 * Postgres in every deployment (the hosted Workers and the self-hosted Deno
 * process alike); DuckDB is only the metrics sample store.
 *
 * The value is overwritten in place: there is no history of older
 * generations. A sample that names an older generation than the stored one
 * simply finds no matching topology and is read against the latest context.
 * Sizes (RAM, CPU, disk) are carried on every sample and are not stored here.
 * Nothing a host operator or a daemon sends can make the value grow without
 * bound. Limits that hold whatever the daemon says:
 *
 * - `generation` and `bootGeneration` are integers that fit
 *   {@link MAX_TOPOLOGY_GENERATION}; the snapshot is at most 64 KiB
 *   (`validateDaemonInboundFrame`, before any write, on both the Workers and
 *   the Deno path).
 * - at most {@link MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR} generation changes
 *   per server per rolling hour and {@link MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY}
 *   per rolling day (the change times are kept in the value, at most that many);
 *   the rest are dropped and `server.metadata.topologyChurnLimitedAt` is
 *   stamped as an alert.
 * - a resend of the stored generation is throttled to one write per server per
 *   {@link TOPOLOGY_REWRITE_COOLDOWN_SECONDS} seconds.
 *
 * Every report runs under a lock on the server's row, so concurrent reports
 * cannot slip past the counters together.
 */
import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import type { TopologyLayoutPaths } from '../../contracts/topology-types.ts'

/** Largest generation number the value stores (a Postgres `integer`). */
export const MAX_TOPOLOGY_GENERATION = 2_147_483_647
/** Generation changes recorded per server per rolling hour; honest hardware changes are rare. */
export const MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR = 12
/** Generation changes recorded per server per rolling day. */
export const MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY = 24
/** Minimum seconds between two rewrites (a resend of the stored generation) for one server. */
export const TOPOLOGY_REWRITE_COOLDOWN_SECONDS = 30
/** The churn alert stamp is rewritten at most this often, so a flood cannot also write the server row every message. */
const CHURN_STAMP_REFRESH_SECONDS = 300

export type TopologyGenerationRecord = {
  generation: number
  bootGeneration: number
  snapshot: unknown
  appliedAt: string
}

/** What `server.hardware` stores: the record plus the write bookkeeping. */
type StoredHardware = TopologyGenerationRecord & {
  /** When the value was last written. */
  updatedAt: string
  /** Times of the latest generation changes, newest first, at most a day old and at most the daily limit. */
  changes: string[]
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

/** The topology record inside a selected `server.hardware` value, or `undefined` when absent or malformed. */
export function topologyRecordFromColumn(value: unknown): TopologyGenerationRecord | undefined {
  return toRecord(parseStored(value))
}

/** A stored `server.hardware` value, or `undefined` when it is absent or malformed. */
function parseStored(value: unknown): StoredHardware | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (
    typeof raw.generation !== 'number' ||
    typeof raw.bootGeneration !== 'number' ||
    typeof raw.appliedAt !== 'string'
  ) {
    return undefined
  }
  return {
    generation: raw.generation,
    bootGeneration: raw.bootGeneration,
    snapshot: raw.snapshot ?? null,
    appliedAt: raw.appliedAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.appliedAt,
    changes: Array.isArray(raw.changes)
      ? raw.changes.filter((entry): entry is string => typeof entry === 'string')
      : [],
  }
}

function toRecord(stored: StoredHardware | undefined): TopologyGenerationRecord | undefined {
  if (!stored) return undefined
  return {
    generation: stored.generation,
    bootGeneration: stored.bootGeneration,
    snapshot: stored.snapshot,
    appliedAt: stored.appliedAt,
  }
}

export type RecordTopologyGenerationOutcome =
  /** A new generation became the stored one. */
  | 'recorded'
  /** A resend of the stored generation changed its snapshot. */
  | 'refreshed'
  /** Nothing to do: an identical resend, or a rewrite inside the cooldown. */
  | 'unchanged'
  /** The server hit its hourly or daily limit of generation changes; nothing was written. */
  | 'rate_limited'
  /** The numbers do not fit; nothing was written. */
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
      ? `topology generation limit reached for server ${serverId}: more than ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR} generation changes in an hour or ${MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY} in a day; further reports are dropped`
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

async function writeHardware(db: Pick<Db, 'update'>, serverId: string, value: StoredHardware) {
  await db
    .update(server)
    .set({
      hardware: sql`${JSON.stringify(value)}::jsonb`,
      // Not an edit of the server: keep the version stamp the cached screens read.
      updatedAt: sql`${server.updatedAt}`,
    })
    .where(eq(server.id, serverId))
}

/**
 * Record one topology report, within the limits in the module doc, under a
 * lock on the server's row (`FOR UPDATE`, the same pattern as
 * `capability-plan-records.ts`) so two reports for one server are handled one
 * after the other and the counters cannot be raced.
 *
 * - The stored generation sent again never counts as a change. Its snapshot is
 *   refreshed when it differs, at most once per
 *   {@link TOPOLOGY_REWRITE_COOLDOWN_SECONDS}.
 * - Any other generation number replaces the stored value if the hourly and
 *   daily limits allow it. "Latest" is by write time, never by the daemon's own
 *   number, so a forged huge number cannot pin itself: an honest daemon
 *   reporting its own number replaces it (counted as a change).
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

  const outcome = await db.transaction(async (tx): Promise<RecordTopologyGenerationOutcome> => {
    const [row] = await tx
      .select({ hardware: server.hardware })
      .from(server)
      .where(eq(server.id, serverId))
      .for('update')
      .limit(1)
    if (!row) return 'unchanged'
    const current = parseStored(row.hardware)
    const now = new Date()
    const nowIso = now.toISOString()

    if (current?.generation === report.generation) {
      const sinceWrite = now.getTime() - Date.parse(current.updatedAt)
      if (sinceWrite < TOPOLOGY_REWRITE_COOLDOWN_SECONDS * 1000) return 'unchanged'
      const same =
        JSON.stringify(current.snapshot ?? null) === JSON.stringify(report.snapshot ?? null) &&
        current.bootGeneration === report.bootGeneration
      if (same) return 'unchanged'
      await writeHardware(tx, serverId, {
        ...current,
        bootGeneration: report.bootGeneration,
        snapshot: report.snapshot ?? null,
        appliedAt: report.appliedAt,
        updatedAt: nowIso,
      })
      return 'refreshed'
    }

    const dayAgo = now.getTime() - 24 * 60 * 60 * 1000
    const hourAgo = now.getTime() - 60 * 60 * 1000
    const recent = (current?.changes ?? []).filter((at) => Date.parse(at) > dayAgo)
    const lastHour = recent.filter((at) => Date.parse(at) > hourAgo).length
    if (
      lastHour >= MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR ||
      recent.length >= MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY
    ) {
      await markTopologyChurnLimited(tx, serverId)
      return 'rate_limited'
    }

    await writeHardware(tx, serverId, {
      generation: report.generation,
      bootGeneration: report.bootGeneration,
      snapshot: report.snapshot ?? null,
      appliedAt: report.appliedAt,
      updatedAt: nowIso,
      changes: [nowIso, ...recent].slice(0, MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY),
    })
    await clearTopologyChurnLimited(tx, serverId)
    return 'recorded'
  })

  if (outcome === 'rate_limited') logTopologyChurn(serverId, 'rate_limited')
  return outcome
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

/** The topology last recorded for a server, or `undefined` if none has been reported yet. */
export async function getLatestTopologyGeneration(
  db: Pick<Db, 'select'>,
  serverId: string
): Promise<TopologyGenerationRecord | undefined> {
  const [row] = await db
    .select({ hardware: server.hardware })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return toRecord(parseStored(row?.hardware))
}

/**
 * The topology last recorded for each of `serverIds`, in one query — the
 * batched analogue of {@link getLatestTopologyGeneration} for routes that must
 * stay O(1) in the number of servers (e.g. `/servers/metrics/latest`'s fleet
 * snapshot — see `AGENTS.md`'s fleet-read invariant). A server with nothing
 * recorded is simply absent from the returned map rather than mapped to
 * `undefined`, so callers can use `.has()` / `.get()` directly.
 */
export async function getLatestTopologyGenerations(
  db: Pick<Db, 'select'>,
  serverIds: readonly string[]
): Promise<Map<string, TopologyGenerationRecord>> {
  if (serverIds.length === 0) return new Map()
  const rows = await db
    .select({ id: server.id, hardware: server.hardware })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  const out = new Map<string, TopologyGenerationRecord>()
  for (const row of rows) {
    const record = toRecord(parseStored(row.hardware))
    if (record) out.set(row.id, record)
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

/**
 * The stored topology when its generation is `generation`, else `undefined`:
 * older generations are not kept, so a sample naming one reads as unknown.
 */
export async function getTopologyGeneration(
  db: Pick<Db, 'select'>,
  serverId: string,
  generation: number
): Promise<TopologyGenerationRecord | undefined> {
  const latest = await getLatestTopologyGeneration(db, serverId)
  return latest?.generation === generation ? latest : undefined
}

/**
 * Several generations at once, keyed by generation number. Only the stored
 * (latest) generation can be present; callers fall back to the latest context
 * for the rest (see {@link getTopologyGeneration}).
 */
export async function getTopologyGenerations(
  db: Pick<Db, 'select'>,
  serverId: string,
  generations: readonly number[]
): Promise<Map<number, TopologyGenerationRecord>> {
  const latest = await getLatestTopologyGeneration(db, serverId)
  if (!latest || !generations.includes(latest.generation)) return new Map()
  return new Map([[latest.generation, latest]])
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
