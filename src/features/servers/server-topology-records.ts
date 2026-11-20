/**
 * The latest daemon-reported topology (`server.hardware`, see
 * `../../db/schema.ts`) — one value per server, written when the daemon's
 * fire-and-forget `topology-report` cell message lands (see
 * `../../daemon/cell/protocol.ts`). The column lives in the control plane's
 * Postgres in every deployment (the hosted Workers and the self-hosted Deno
 * process alike); DuckDB is only the metrics sample store.
 *
 * The value is overwritten in place: there is no history of older
 * topologies. A sample that names a device the stored snapshot lacks simply
 * finds no matching topology and is read against the latest context.
 * Sizes (RAM, CPU, disk) are carried on every sample and are not stored here.
 * Nothing a host operator or a daemon sends can make the value grow without
 * bound. Limits that hold whatever the daemon says:
 *
 * - The snapshot is at most 64 KiB (`validateDaemonInboundFrame`, before any
 *   write, on both the Workers and the Deno path). A daemon that still sends
 *   the retired `generation` / `bootGeneration` numbers is accepted; the
 *   numbers are never read, and the record has no field for them. A snapshot
 *   from an older daemon can still carry them inside `snapshot`, as received.
 *   `topologyIdentityKey` ignores them.
 * - at most {@link MAX_TOPOLOGY_CHANGES_PER_HOUR} topology changes
 *   per server per rolling hour and {@link MAX_TOPOLOGY_CHANGES_PER_DAY}
 *   per rolling day (the change times are kept in the value, at most that many);
 *   the rest are dropped and `server.metadata.topologyChurnLimitedAt` is
 *   stamped as an alert.
 * - a resend of the stored topology is throttled to one write per server per
 *   {@link TOPOLOGY_REWRITE_COOLDOWN_SECONDS} seconds.
 *
 * A "topology change" is a report with a different `topologyIdentityKey`
 * (`./topology-identity.ts`).
 *
 * Every report runs under a lock on the server's row, so concurrent reports
 * cannot slip past the counters together.
 */
import { eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import type { TopologyLayoutPaths } from '../../contracts/topology-types.ts'
import { reportIsSameTopology } from './topology-identity.ts'

/** Topology changes recorded per server per rolling hour; honest hardware changes are rare. */
export const MAX_TOPOLOGY_CHANGES_PER_HOUR = 12
/** Topology changes recorded per server per rolling day. */
export const MAX_TOPOLOGY_CHANGES_PER_DAY = 24
/** Minimum seconds between two rewrites (a resend of the stored topology) for one server. */
export const TOPOLOGY_REWRITE_COOLDOWN_SECONDS = 30
/** The churn alert stamp is rewritten at most this often, so a flood cannot also write the server row every message. */
const CHURN_STAMP_REFRESH_SECONDS = 300

export type ServerTopologyRecord = {
  snapshot: unknown
  appliedAt: string
  /** When the stored value was last written; it changes whenever the snapshot is rewritten, even for the same topology. */
  updatedAt: string
}

/** What `server.hardware` stores: the record plus the write bookkeeping. */
type StoredHardware = ServerTopologyRecord & {
  /** Times of the latest topology changes, newest first, at most a day old and at most the daily limit. */
  changes: string[]
}

/** Parameters for {@link recordTopologyReport} — the daemon's own report, verbatim. */
export type TopologyReportInput = {
  /** The daemon-reported topology object, stored as-is — never a wrapper around it. */
  snapshot: unknown
  /** The daemon's own report timestamp (`topology-report.at`) — never a control-plane receipt time. */
  appliedAt: string
}

/** The topology record inside a selected `server.hardware` value, or `undefined` when absent or malformed. */
export function topologyRecordFromColumn(value: unknown): ServerTopologyRecord | undefined {
  return toRecord(parseStored(value))
}

/** A stored `server.hardware` value, or `undefined` when it is absent or malformed. */
function parseStored(value: unknown): StoredHardware | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.appliedAt !== 'string') return undefined
  return {
    snapshot: raw.snapshot ?? null,
    appliedAt: raw.appliedAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.appliedAt,
    changes: Array.isArray(raw.changes)
      ? raw.changes.filter((entry): entry is string => typeof entry === 'string')
      : [],
  }
}

function toRecord(stored: StoredHardware | undefined): ServerTopologyRecord | undefined {
  if (!stored) return undefined
  return {
    snapshot: stored.snapshot,
    appliedAt: stored.appliedAt,
    updatedAt: stored.updatedAt,
  }
}

export type RecordTopologyReportOutcome =
  /** A new topology became the stored one. */
  | 'recorded'
  /** A resend of the stored topology changed its snapshot. */
  | 'refreshed'
  /** Nothing to do: an identical resend, or a rewrite inside the cooldown. */
  | 'unchanged'
  /** The server hit its hourly or daily limit of topology changes; nothing was written. */
  | 'rate_limited'

const CHURN_LOG_COOLDOWN_MS = 10 * 60 * 1000
const MAX_CHURN_LOG_KEYS = 1000
const churnLogAt = new Map<string, number>()

/** One alert line per server per cooldown, so a flood cannot also flood the log. */
function logTopologyChurn(serverId: string, outcome: 'rate_limited'): void {
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
    `topology limit reached for server ${serverId}: more than ${MAX_TOPOLOGY_CHANGES_PER_HOUR} topology changes in an hour or ${MAX_TOPOLOGY_CHANGES_PER_DAY} in a day; further reports are dropped`
  )
}

/** Test seam: forget the alert cooldowns. */
export function resetTopologyChurnLogForTests(): void {
  churnLogAt.clear()
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
 * - The stored topology sent again (`reportIsSameTopology`: the same
 *   identity key) never
 *   counts as a change. Its snapshot is refreshed when it differs, at most
 *   once per {@link TOPOLOGY_REWRITE_COOLDOWN_SECONDS}.
 * - Any other topology replaces the stored value if the hourly and
 *   daily limits allow it. "Latest" is by write time.
 */
export async function recordTopologyReport(
  db: Db,
  serverId: string,
  report: TopologyReportInput
): Promise<RecordTopologyReportOutcome> {
  const outcome = await db.transaction(async (tx): Promise<RecordTopologyReportOutcome> => {
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

    if (current && reportIsSameTopology(current, report)) {
      const sinceWrite = now.getTime() - Date.parse(current.updatedAt)
      if (sinceWrite < TOPOLOGY_REWRITE_COOLDOWN_SECONDS * 1000) return 'unchanged'
      const same =
        JSON.stringify(current.snapshot ?? null) === JSON.stringify(report.snapshot ?? null)
      if (same) return 'unchanged'
      await writeHardware(tx, serverId, {
        changes: current.changes,
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
      lastHour >= MAX_TOPOLOGY_CHANGES_PER_HOUR ||
      recent.length >= MAX_TOPOLOGY_CHANGES_PER_DAY
    ) {
      await markTopologyChurnLimited(tx, serverId)
      return 'rate_limited'
    }

    await writeHardware(tx, serverId, {
      snapshot: report.snapshot ?? null,
      appliedAt: report.appliedAt,
      updatedAt: nowIso,
      changes: [nowIso, ...recent].slice(0, MAX_TOPOLOGY_CHANGES_PER_DAY),
    })
    await clearTopologyChurnLimited(tx, serverId)
    return 'recorded'
  })

  if (outcome === 'rate_limited') logTopologyChurn(serverId, 'rate_limited')
  return outcome
}

/**
 * Stamp `server.metadata.topologyChurnLimitedAt`: the durable alert that this
 * server tried to report more topology changes than the limits allow (a
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

/** `true` while a recent refusal says the server is over its topology limits. */
export function topologyChurnLimitedRecently(serverMetadata: unknown, nowMs = Date.now()): boolean {
  if (typeof serverMetadata !== 'object' || serverMetadata === null) return false
  const at = (serverMetadata as Record<string, unknown>).topologyChurnLimitedAt
  if (typeof at !== 'string') return false
  const stampedMs = Date.parse(at)
  return Number.isFinite(stampedMs) && nowMs - stampedMs < TOPOLOGY_CHURN_HOLD_MS
}

/** The topology last recorded for a server, or `undefined` if none has been reported yet. */
export async function getLatestServerTopology(
  db: Pick<Db, 'select'>,
  serverId: string
): Promise<ServerTopologyRecord | undefined> {
  const [row] = await db
    .select({ hardware: server.hardware })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return toRecord(parseStored(row?.hardware))
}

/**
 * The topology last recorded for each of `serverIds`, in one query — the
 * batched analogue of {@link getLatestServerTopology} for routes that must
 * stay O(1) in the number of servers (e.g. `/servers/metrics/latest`'s fleet
 * snapshot — see `AGENTS.md`'s fleet-read invariant). A server with nothing
 * recorded is simply absent from the returned map rather than mapped to
 * `undefined`, so callers can use `.has()` / `.get()` directly.
 */
export async function getLatestServerTopologies(
  db: Pick<Db, 'select'>,
  serverIds: readonly string[]
): Promise<Map<string, ServerTopologyRecord>> {
  if (serverIds.length === 0) return new Map()
  const rows = await db
    .select({ id: server.id, hardware: server.hardware })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  const out = new Map<string, ServerTopologyRecord>()
  for (const row of rows) {
    const record = toRecord(parseStored(row.hardware))
    if (record) out.set(row.id, record)
  }
  return out
}

/**
 * Stamp `server.metadata.topologyResyncRequestedAt` — the durable signal
 * that `POST /api/daemon/v1/metrics` emits (see `api-routes.ts`) when a
 * sample does not match the topology recorded via
 * {@link recordTopologyReport} (`sampleMatchesRecordedTopology`). Ingest must never wake the Durable
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
 * `DISTINCT ON` query over `server.hardware`; servers with no topology
 * yet (or a pre-v6 daemon) are simply absent from the map.
 */
export async function loadServerLayoutPaths(
  db: Db,
  serverIds: readonly string[]
): Promise<Map<string, TopologyLayoutPaths>> {
  const out = new Map<string, TopologyLayoutPaths>()
  const latest = await getLatestServerTopologies(db, serverIds)
  for (const [serverId, record] of latest) {
    const paths = layoutPathsFromSnapshot(record.snapshot)
    if (paths) out.set(serverId, paths)
  }
  return out
}
