/**
 * Cloudflare container-log store: **Pipelines in, R2 SQL out.**
 *
 * Write path: a Workers Pipelines binding (`env.<BINDING>.send(records)`)
 * accepts already-batched rows and sinks them into an Apache Iceberg table in
 * R2 Data Catalog. Read path: the R2 SQL HTTP query API scans that table.
 *
 *   POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{account_id}/r2-sql/query/{bucket}
 *   Authorization: Bearer <R2 SQL + Data Catalog + R2 read token>
 *   Content-Type: application/json
 *   { "query": "SELECT … FROM namespace.table WHERE … LIMIT n" }
 *
 * This is the Workers mirror of `../clickhouse/store.ts`: same
 * `ContainerLogStore` contract, same closed predicate set, same newest-first
 * page shape. The response unwrap deliberately mirrors
 * `parseCloudflareV4SqlResponse`
 * (`src/daemon/metrics/analytics-engine/sql-api.ts`) rather than inventing a
 * second error-handling dialect for Cloudflare envelopes.
 *
 * **One request field, no budget knobs — so reads fail closed.** The R2 SQL
 * API body is exactly `{ "query": "…" }`: no scanned-bytes cap, cost ceiling,
 * or timeout to send, even though R2 SQL bills on compressed bytes scanned.
 * Since no hard ceiling can be sent, this store refuses the reads it cannot
 * bound instead of issuing them uncapped — a clamped row `LIMIT`, a
 * `[from, to)` window capped at `maxRangeSeconds` (24 h by default, not the
 * retention window), and a much tighter `maxUnselectiveRangeSeconds` for a
 * query carrying no `serverId` / `serviceId` / `containerId`. A read past the
 * unselective bound raises {@link ContainerLogStoreUnavailableError} naming the
 * missing ceiling, so the route answers `503 container_logs_unavailable`
 * rather than silently billing for a full-tenant scan. See `./config.ts`.
 *
 * **No parameter binding.** The R2 SQL API takes one SQL string, exactly like
 * the Analytics Engine SQL API. Every literal is therefore either validated
 * against a strict shape (UUID, ISO timestamp, `stdout`/`stderr`) or escaped
 * with {@link quoteR2SqlString}. `organizationId` is injected by this store
 * from `ContainerLogQuery.organizationId` and can never be caller SQL.
 *
 * **Tenancy:** `query()` scopes every read to `ContainerLogQuery.organizationId`
 * and that field is required. This store has no knowledge of authentication —
 * the caller MUST pass the *authenticated* organization id and must never
 * forward one taken from a request body, query string, or header.
 *
 * **Public beta.** R2 Data Catalog and R2 SQL are both Cloudflare public-beta
 * products. Transport failures surface as
 * {@link ContainerLogStoreUnavailableError} so the route layer can turn them
 * into a `503` instead of a `500`, and so an operator can tell "the beta
 * backend is down" from "this code is wrong".
 *
 * @see https://developers.cloudflare.com/r2-sql/query-data/
 * @see https://developers.cloudflare.com/r2-sql/sql-reference/
 */

import {
  resolveContainerLogQueryLimit,
  truncateContainerLogMessage,
  type ContainerLogEvent,
  type ContainerLogPage,
  type ContainerLogQuery,
  type ContainerLogStore,
  type ContainerLogStream,
} from '../types.ts'
import {
  CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS,
  CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS,
  type ContainerLogsCloudflareConfig,
} from './config.ts'

/**
 * Structural subset of Cloudflare's Pipelines binding this driver uses.
 *
 * Declared here — exactly like `R2BucketLike` in
 * `../../execution-logs/r2-store.ts` — so the Deno type-check (which has no
 * Workers types) and the test fakes both satisfy it without pulling in
 * `worker-configuration.d.ts`.
 */
export type PipelineLike = {
  send(records: unknown[]): Promise<void>
}

/**
 * The beta backend could not be reached or refused the request.
 *
 * Distinct from a `TypeError` (which always means a bad argument reached this
 * store) so the read route can answer `503` rather than `500`.
 */
export class ContainerLogStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ContainerLogStoreUnavailableError'
  }
}

/** Column list of the Iceberg table, in `SELECT` order. */
export const CONTAINER_LOG_ICEBERG_COLUMNS = [
  'timestamp',
  'organization_id',
  'server_id',
  'environment_id',
  'service_id',
  'container_id',
  'stream',
  'message',
  'row_id',
] as const

export type PipelinesIcebergContainerLogStoreOptions = {
  /** Injected id generator (tests). Defaults to `crypto.randomUUID`. */
  newRowId?: () => string
}

/** One flat Iceberg row — one column per predicate, never a JSON blob. */
export type ContainerLogIcebergRow = {
  timestamp: string
  organization_id: string
  server_id: string
  environment_id: string | null
  service_id: string | null
  container_id: string
  stream: ContainerLogStream
  message: string
  row_id: string
}

export class PipelinesIcebergContainerLogStore implements ContainerLogStore {
  readonly #pipeline: PipelineLike
  readonly #config: ContainerLogsCloudflareConfig
  readonly #newRowId: () => string

  constructor(
    pipeline: PipelineLike,
    config: ContainerLogsCloudflareConfig,
    options?: PipelinesIcebergContainerLogStoreOptions
  ) {
    this.#pipeline = pipeline
    this.#config = config
    this.#newRowId = options?.newRowId ?? (() => crypto.randomUUID())
  }

  /**
   * Send an already-batched array to the Pipeline in **exactly one** `send`.
   *
   * The daemon-side collector batches (`MAX_CONTAINER_LOG_INGEST_BATCH` is
   * enforced there); this store never splits, re-batches, or sends per event.
   * Batching is the whole cost story for this backend: R2 Data Catalog bills
   * catalog operations per-million and compaction per-GB/object, so a
   * send-per-line write path would multiply both. An empty batch is a no-op
   * that does not touch the binding at all.
   */
  async ingest(events: readonly ContainerLogEvent[]): Promise<void> {
    if (events.length === 0) return
    const records = events.map((event) => buildContainerLogIcebergRow(event, this.#newRowId))
    try {
      await this.#pipeline.send(records)
    } catch (cause) {
      throw new ContainerLogStoreUnavailableError(
        `container log pipeline send failed for ${records.length} rows`,
        { cause }
      )
    }
  }

  async query(q: ContainerLogQuery): Promise<ContainerLogPage> {
    const limit = resolveContainerLogQueryLimit(q.limit)
    const maxRangeSeconds =
      this.#config.maxRangeSeconds ?? CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS
    const sql = buildContainerLogR2Sql(q, {
      table: this.#config.table,
      limit,
      maxRangeSeconds,
      maxUnselectiveRangeSeconds: Math.min(
        this.#config.maxUnselectiveRangeSeconds ??
          CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS,
        maxRangeSeconds
      ),
    })
    const rows = await executeR2Sql(this.#config, sql)
    const events = rows.map((row) => parseContainerLogIcebergRow(row))
    const lastRow = rows.at(-1)
    const nextCursor =
      events.length >= limit && lastRow
        ? encodeContainerLogCursor(events.at(-1)!.timestamp, String(lastRow.row_id ?? ''))
        : null
    return { events, nextCursor }
  }
}

/**
 * Map one event onto the flat Iceberg column plan.
 *
 * The columns are the ClickHouse `ORDER BY` tuple plus the remaining
 * predicates — `(organization_id, server_id, service_id, timestamp)` first —
 * so the two backends answer the same closed question set with the same
 * physical layout. `row_id` is the one addition; see
 * {@link encodeContainerLogCursor}.
 */
export function buildContainerLogIcebergRow(
  event: ContainerLogEvent,
  newRowId: () => string = () => crypto.randomUUID()
): ContainerLogIcebergRow {
  return {
    timestamp: assertIsoTimestamp('timestamp', event.timestamp).toISOString(),
    organization_id: assertUuid('organizationId', event.organizationId),
    server_id: assertUuid('serverId', event.serverId),
    environment_id:
      event.environmentId === null ? null : assertUuid('environmentId', event.environmentId),
    service_id: event.serviceId === null ? null : assertUuid('serviceId', event.serviceId),
    container_id: event.containerId,
    stream: assertStream(event.stream),
    message: truncateContainerLogMessage(event.message),
    row_id: newRowId(),
  }
}

/** Parse one R2 SQL row back into the storage-agnostic contract shape. */
export function parseContainerLogIcebergRow(row: Record<string, unknown>): ContainerLogEvent {
  return {
    timestamp: normalizeIsoTimestamp(String(row.timestamp ?? '')),
    organizationId: String(row.organization_id ?? ''),
    serverId: String(row.server_id ?? ''),
    environmentId: row.environment_id == null ? null : String(row.environment_id),
    serviceId: row.service_id == null ? null : String(row.service_id),
    containerId: String(row.container_id ?? ''),
    stream: row.stream === 'stderr' ? 'stderr' : 'stdout',
    message: String(row.message ?? ''),
  }
}

/**
 * Build the newest-first `SELECT` for one page.
 *
 * Predicate order matches the partition/sort plan
 * (`organization_id, server_id, service_id, timestamp`) so the engine can prune
 * Iceberg data files before it reads any. The `organization_id` equality is
 * always emitted first and always comes from `q.organizationId` — a caller
 * cannot omit, widen, or override it.
 */
export function buildContainerLogR2Sql(
  q: ContainerLogQuery,
  opts: {
    table: string
    limit: number
    maxRangeSeconds: number
    /**
     * Window cap for a query with no selective predicate. Omit only in tests
     * that are asserting SQL shape rather than the scan budget.
     */
    maxUnselectiveRangeSeconds?: number
  }
): string {
  const table = assertSafeTableIdentifier(opts.table)
  const from = assertIsoTimestamp('from', q.from)
  const to = assertIsoTimestamp('to', q.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertScanBudget(q, from, to, opts.maxUnselectiveRangeSeconds ?? opts.maxRangeSeconds)

  // Sort-key prefix first, most selective to least.
  const conditions = [
    `organization_id = ${quoteR2SqlString(assertUuid('organizationId', q.organizationId))}`,
  ]
  if (q.serverId !== undefined) {
    conditions.push(`server_id = ${quoteR2SqlString(assertUuid('serverId', q.serverId))}`)
  }
  if (q.serviceId !== undefined) {
    conditions.push(`service_id = ${quoteR2SqlString(assertUuid('serviceId', q.serviceId))}`)
  }
  // Timestamp literals are RFC3339 strings; R2 SQL coerces Utf8 to the
  // Iceberg timestamp column type in a binary comparison.
  conditions.push(
    `timestamp >= ${quoteR2SqlString(from.toISOString())}`,
    `timestamp < ${quoteR2SqlString(to.toISOString())}`,
  )

  // Off-sort-key predicates last — they filter rows, they cannot prune files.
  if (q.environmentId !== undefined) {
    conditions.push(
      `environment_id = ${quoteR2SqlString(assertUuid('environmentId', q.environmentId))}`
    )
  }
  if (q.containerId !== undefined) {
    conditions.push(`container_id = ${quoteR2SqlString(q.containerId)}`)
  }
  if (q.stream !== undefined) {
    conditions.push(`stream = ${quoteR2SqlString(assertStream(q.stream))}`)
  }
  if (q.search !== undefined && q.search !== '') {
    const pattern = quoteR2SqlString('%' + escapeLikePattern(q.search) + '%')
    conditions.push(`message ILIKE ${pattern}`)
  }

  // Keyset pagination on the total order `(timestamp, row_id)`.
  //
  // This is the one place the Iceberg backend deliberately **diverges** from
  // ClickHouse. ClickHouse has no stable per-row tie-break (adding a column
  // would cost every existing row), so a page boundary inside a run of rows
  // sharing one millisecond silently drops the rest of that run. This table is
  // new, so it carries `row_id` from the first write: unique per row, which is
  // all a tie-break needs — the values are not meaningful, they merely make
  // `(timestamp, row_id)` a total order, so no row is ever skipped or repeated
  // across a page boundary.
  if (q.cursor !== undefined && q.cursor !== '') {
    const { timestamp, rowId } = decodeContainerLogCursor(q.cursor)
    const ts = quoteR2SqlString(timestamp)
    conditions.push(
      `(timestamp < ${ts} OR (timestamp = ${ts} AND row_id < ${quoteR2SqlString(rowId)}))`
    )
  }

  return [
    `SELECT ${CONTAINER_LOG_ICEBERG_COLUMNS.join(', ')}`,
    `FROM ${table}`,
    `WHERE ${conditions.join('\n  AND ')}`,
    'ORDER BY timestamp DESC, row_id DESC',
    // The strongest budget this backend allows: a clamped LIMIT (see
    // `resolveContainerLogQueryLimit`) over a `[from, to)` window that
    // `assertRange` and `assertScanBudget` already refused to let exceed the
    // configured caps. Both are scan *proxies* — R2 SQL accepts no
    // scanned-bytes cap, so actual bytes read still depend on data-file sizes
    // and compaction state.
    `LIMIT ${assertPositiveInt('limit', opts.limit)}`,
  ].join('\n')
}

/**
 * POST one query to the R2 SQL HTTP API and unwrap its rows.
 *
 * The body is `{ query }` and nothing else — that is the entire documented
 * request shape. If Cloudflare ever ships a scanned-bytes budget field, this
 * is the one place to add it (plus a config field to carry it).
 */
async function executeR2Sql(
  config: ContainerLogsCloudflareConfig,
  sql: string
): Promise<Array<Record<string, unknown>>> {
  const accountId = config.accountId.trim()
  if (!accountId) {
    throw new TypeError('CLOUDFLARE_ACCOUNT_ID is required for R2 SQL')
  }
  const token = config.apiToken.trim()
  if (!token) {
    throw new TypeError('TURBOPANEL_CONTAINER_LOGS_R2_SQL_API_TOKEN is required for R2 SQL')
  }
  const bucket = config.bucket.trim()
  if (!bucket) {
    throw new TypeError('TURBOPANEL_CONTAINER_LOGS_R2_SQL_BUCKET is required for R2 SQL')
  }
  const url =
    `https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(accountId)}` +
    `/r2-sql/query/${encodeURIComponent(bucket)}`
  const fetchFn = config.fetch ?? fetch

  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    })
  } catch (cause) {
    throw new ContainerLogStoreUnavailableError('R2 SQL request failed', { cause })
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new ContainerLogStoreUnavailableError(
      `R2 SQL HTTP ${response.status}: ${body.slice(0, 500)}`
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new ContainerLogStoreUnavailableError('R2 SQL response is not JSON', { cause })
  }
  return parseR2SqlResponse(body)
}

/**
 * Validate and unwrap an R2 SQL response.
 *
 * Mirrors `parseCloudflareV4SqlResponse` rather than diverging: prefer the
 * client/v4 envelope `{ success, errors, result }`, and also accept a bare
 * `{ rows }` / `{ data }` body so a successful result is never discarded as an
 * opaque `success: false`. R2 SQL is in public beta and its envelope has
 * shifted; being tolerant on the read side is cheaper than a redeploy.
 */
export function parseR2SqlResponse(body: unknown): Array<Record<string, unknown>> {
  if (!isPlainObject(body)) {
    throw new ContainerLogStoreUnavailableError('R2 SQL response is not a JSON object')
  }
  const envelope = body as {
    success?: boolean
    errors?: Array<{ code?: number; message?: string } | string>
    result?: unknown
    rows?: unknown
    data?: unknown
  }

  if (envelope.success === false) {
    throw new ContainerLogStoreUnavailableError(
      `R2 SQL API error: ${collectR2SqlFailureDetail(envelope.errors)}`
    )
  }

  const candidates: unknown[] = [envelope.result, envelope.rows, envelope.data]
  if (isPlainObject(envelope.result)) {
    const result = envelope.result as { rows?: unknown; data?: unknown }
    candidates.push(result.rows, result.data)
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isPlainObject)
  }
  // A successful query that matched nothing.
  return []
}

function collectR2SqlFailureDetail(
  errors: Array<{ code?: number; message?: string } | string> | undefined
): string {
  if (!Array.isArray(errors) || errors.length === 0) return 'unknown error'
  return errors
    .map((error) =>
      typeof error === 'string' ? error : (error.message ?? `code ${String(error.code)}`)
    )
    .join('; ')
}

/**
 * Opaque, URL-safe page cursor over the total order `(timestamp, row_id)`.
 * Content is an implementation detail; callers round-trip it verbatim.
 */
export function encodeContainerLogCursor(isoTimestamp: string, rowId: string): string {
  return btoa(`${isoTimestamp}|${rowId}`)
}

export function decodeContainerLogCursor(cursor: string): {
  timestamp: string
  rowId: string
} {
  let decoded: string
  try {
    decoded = atob(cursor)
  } catch {
    throw new TypeError(`invalid container log cursor: ${cursor}`)
  }
  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) {
    throw new TypeError(`invalid container log cursor: ${cursor}`)
  }
  const timestamp = assertIsoTimestamp('cursor', decoded.slice(0, separator)).toISOString()
  const rowId = decoded.slice(separator + 1)
  if (!rowId) throw new TypeError(`invalid container log cursor: ${cursor}`)
  return { timestamp, rowId }
}

/**
 * Escape a string literal for R2 SQL (single-quote doubling).
 * There is no parameter binding — only call with pre-validated values.
 */
export function quoteR2SqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Escape LIKE wildcards so a user's `%` / `_` matches literally. */
function escapeLikePattern(value: string): string {
  return value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('%', String.raw`\%`)
    .replaceAll('_', String.raw`\_`)
}

/** `namespace.table` — both halves plain identifiers, never caller input. */
function assertSafeTableIdentifier(table: string): string {
  if (!/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/.test(table)) {
    throw new TypeError(`invalid R2 SQL table identifier: ${table}`)
  }
  return table
}

function assertStream(stream: ContainerLogStream): ContainerLogStream {
  if (stream !== 'stdout' && stream !== 'stderr') {
    throw new TypeError(`invalid container log stream: ${String(stream)}`)
  }
  return stream
}

function assertUuid(label: string, value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`invalid ${label} for R2 SQL: ${value}`)
  }
  return value
}

function assertIsoTimestamp(label: string, value: string): Date {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new TypeError(`invalid ${label} timestamp: ${value}`)
  }
  return new Date(ms)
}

function assertPositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

/** Predicates that let the engine prune Iceberg data files inside the window. */
function hasSelectivePredicate(q: ContainerLogQuery): boolean {
  return q.serverId !== undefined || q.serviceId !== undefined || q.containerId !== undefined
}

/**
 * Refuse a read this backend gives us no way to bound.
 *
 * A query filtered only by `organization_id` prunes nothing beyond the time
 * partition: it reads every data file in the window, for every server the
 * tenant owns. On a backend that accepts a scanned-bytes ceiling this would be
 * capped in the request; R2 SQL accepts none, so the fail-closed answer is to
 * decline rather than issue it and discover the bill afterwards.
 *
 * Raised as {@link ContainerLogStoreUnavailableError} (not `TypeError`) on
 * purpose: the caller's query is well-formed, it is *this backend* that cannot
 * serve it safely, and the read route turns that into `503
 * container_logs_unavailable` with the reason attached.
 */
function assertScanBudget(
  q: ContainerLogQuery,
  from: Date,
  to: Date,
  maxUnselectiveRangeSeconds: number
): void {
  if (hasSelectivePredicate(q)) return
  const spanSeconds = (to.getTime() - from.getTime()) / 1000
  if (spanSeconds <= maxUnselectiveRangeSeconds) return
  throw new ContainerLogStoreUnavailableError(
    `container_logs_unavailable: R2 SQL exposes no scanned-bytes ceiling, so a ` +
      `${spanSeconds}s read with no serverId/serviceId/containerId filter is refused ` +
      `(max ${maxUnselectiveRangeSeconds}s unfiltered). Narrow the time range or add a filter.`
  )
}

function assertRange(from: Date, to: Date, maxRangeSeconds: number): void {
  const spanSeconds = (to.getTime() - from.getTime()) / 1000
  if (spanSeconds < 0) {
    throw new TypeError('from must be <= to')
  }
  if (spanSeconds > maxRangeSeconds) {
    throw new TypeError(`query range ${spanSeconds}s exceeds maxRangeSeconds ${maxRangeSeconds}`)
  }
}

function normalizeIsoTimestamp(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
