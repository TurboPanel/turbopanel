/**
 * Storage-agnostic container-log contract.
 *
 * A container log line is one stdout/stderr record emitted by a running
 * container, stamped with the identity of where it came from
 * (`organization → server → environment → service → container`).
 *
 * Deliberately an **analytics table**, not a keyed object: container logs are
 * queried *across* servers, services and time ("everything my org's api service
 * logged in the last hour, containing `ECONNREFUSED`"), which is exactly the
 * question a columnar store exists to answer and exactly the question an
 * object-per-key layout cannot. This is the mirror image of execution logs
 * (`src/lib/execution-logs/AGENTS.md`), which are only ever read whole for one
 * command id. See `AGENTS.md` in this directory — do not "unify" the two.
 *
 * The predicate set below is fixed on purpose: it is simultaneously the
 * ClickHouse `ORDER BY` prefix and the partition/column plan for the Iceberg
 * backend that comes next. Widening it later is a storage migration, not a
 * type change.
 */

/** Which of the container's two output streams a line came from. */
export type ContainerLogStream = 'stdout' | 'stderr'

/** One container log line, fully identified. */
export type ContainerLogEvent = {
  /** ISO-8601 UTC timestamp of the line (millisecond precision). */
  timestamp: string
  /** Owning organization — the only tenancy boundary. Never client-supplied. */
  organizationId: string
  /** Server the container runs on. */
  serverId: string
  /** Environment the container belongs to; null for containers outside one. */
  environmentId: string | null
  /** Compose service the container belongs to; null for one-off containers. */
  serviceId: string | null
  /** Docker container id (long form). */
  containerId: string
  stream: ContainerLogStream
  /** The line itself, capped at {@link MAX_CONTAINER_LOG_MESSAGE_BYTES}. */
  message: string
}

/**
 * A bounded query over container logs.
 *
 * `organizationId` is **required and non-optional** by design: every read is
 * scoped to exactly one tenant, and the caller must pass the *authenticated*
 * organization id — never a value read from a request body or query string.
 * The store has no knowledge of auth and cannot enforce this for you.
 */
export type ContainerLogQuery = {
  organizationId: string
  /** Inclusive lower bound, ISO-8601. */
  from: string
  /** Exclusive upper bound, ISO-8601. */
  to: string
  serverId?: string
  environmentId?: string
  serviceId?: string
  containerId?: string
  stream?: ContainerLogStream
  /** Case-insensitive substring match on `message`. */
  search?: string
  /** Opaque cursor from a previous {@link ContainerLogPage}. */
  cursor?: string
  /**
   * Defaults to {@link DEFAULT_CONTAINER_LOG_QUERY_LIMIT}, capped at
   * {@link MAX_CONTAINER_LOG_QUERY_LIMIT}.
   */
  limit?: number
}

/** One page of newest-first results. */
export type ContainerLogPage = {
  events: ContainerLogEvent[]
  /** Pass back as {@link ContainerLogQuery.cursor}; null when exhausted. */
  nextCursor: string | null
}

/** Hard cap on rows returned by a single {@link ContainerLogStore.query}. */
export const MAX_CONTAINER_LOG_QUERY_LIMIT = 1000

/** Page size when a query does not ask for one. */
export const DEFAULT_CONTAINER_LOG_QUERY_LIMIT = 200

/** Per-line message cap; longer lines are truncated on ingest. */
export const MAX_CONTAINER_LOG_MESSAGE_BYTES = 32 * 1024

/** Hard cap on events accepted by a single {@link ContainerLogStore.ingest}. */
export const MAX_CONTAINER_LOG_INGEST_BATCH = 5000

/** Default table TTL in days. */
export const CONTAINER_LOG_RETENTION_DAYS = 30

/**
 * Append-only, query-across storage for container output.
 *
 * `ingest` takes an already-batched array — callers (the daemon-side collector)
 * batch, the store does not. `query` is always tenant-scoped and always returns
 * newest-first.
 */
export interface ContainerLogStore {
  /** Persist a batch of lines. A zero-length batch is a no-op. */
  ingest(events: readonly ContainerLogEvent[]): Promise<void>

  /** Read one newest-first page. See {@link ContainerLogQuery} on tenancy. */
  query(q: ContainerLogQuery): Promise<ContainerLogPage>
}

/** Clamp a caller-supplied limit into the documented bounds. */
export function resolveContainerLogQueryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_CONTAINER_LOG_QUERY_LIMIT
  const floored = Math.floor(limit)
  if (floored <= 0) return DEFAULT_CONTAINER_LOG_QUERY_LIMIT
  return Math.min(floored, MAX_CONTAINER_LOG_QUERY_LIMIT)
}

/**
 * Truncate a log line to {@link MAX_CONTAINER_LOG_MESSAGE_BYTES}.
 *
 * The cap is a **UTF-8 byte** cap, not a JavaScript string-length cap: a line
 * of emoji or CJK text costs three or four bytes per code point, so slicing by
 * code units would leave rows far over the documented limit (and could split a
 * surrogate pair). The cut is walked back off any UTF-8 continuation byte so
 * whole code points survive; the result is therefore <= the cap, and may be a
 * few bytes under it.
 */
export function truncateContainerLogMessage(message: string): string {
  const bytes = new TextEncoder().encode(message)
  if (bytes.length <= MAX_CONTAINER_LOG_MESSAGE_BYTES) return message
  let end = MAX_CONTAINER_LOG_MESSAGE_BYTES
  // 0b10xxxxxx marks a continuation byte — cutting there splits a code point.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.subarray(0, end))
}
