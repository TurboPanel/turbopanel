/**
 * Deno ClickHouse container-log store.
 *
 * Reuses the metrics module's narrow HTTP client
 * (`src/daemon/metrics/clickhouse/client.ts`) rather than forking a second one
 * — there is exactly one ClickHouse wire protocol in this repo. Everything
 * else here is container-logs-specific and deliberately decoupled from the
 * metrics store's internals (the small timestamp/range guards are duplicated
 * rather than exported across module boundaries).
 *
 * Fail clearly when configured-but-unavailable: a complete
 * `ClickHouseStoreConfig` means container logs were explicitly enabled, so
 * connection / query failures propagate as thrown errors instead of silently
 * degrading to empty pages. Callers that treat ingest as fire-and-forget must
 * `.catch` themselves.
 *
 * **Tenancy:** `query()` scopes every read to `ContainerLogQuery.organizationId`
 * and that field is required. This store has no knowledge of authentication —
 * the caller (the read API, in a later phase) MUST pass the *authenticated*
 * organization id and must never forward an organization id taken from a
 * request body, query string, or header. Do not regress this when the ingest
 * and read endpoints land.
 */

import { ClickHouseHttpClient } from '../../../daemon/metrics/clickhouse/client.ts'
import type { ClickHouseHttpClientOptions } from '../../../daemon/metrics/clickhouse/client.ts'
import {
  containerLogRowText,
  resolveContainerLogQueryLimit,
  truncateContainerLogMessage,
  type ContainerLogEvent,
  type ContainerLogPage,
  type ContainerLogQuery,
  type ContainerLogStore,
  type ContainerLogStream,
} from '../types.ts'
import {
  buildContainerLogSchemaStatements,
  CONTAINER_LOGS_TABLE,
  DEFAULT_CONTAINER_LOG_RETENTION_DAYS,
} from './schema.ts'

export type ClickHouseContainerLogStoreConfig = {
  url: string
  database: string
  user: string
  password: string
  /** Raw-table TTL days (default 30). Applied on create and via MODIFY TTL. */
  retentionDays?: number
}

export type ClickHouseContainerLogStoreOptions = {
  /** Injected HTTP client (tests). When omitted, built from config. */
  client?: ClickHouseHttpClient
  /** Injected fetch for the default client. */
  fetch?: typeof fetch
  insertTimeoutMs?: number
  queryTimeoutMs?: number
  schemaTimeoutMs?: number
}

export class ClickHouseContainerLogStore implements ContainerLogStore {
  readonly #client: ClickHouseHttpClient
  readonly #retentionDays: number
  #schemaReady = false
  #schemaPromise: Promise<void> | null = null

  constructor(
    config: ClickHouseContainerLogStoreConfig,
    options?: ClickHouseContainerLogStoreOptions
  ) {
    this.#retentionDays = config.retentionDays ?? DEFAULT_CONTAINER_LOG_RETENTION_DAYS
    if (options?.client) {
      this.#client = options.client
    } else {
      const clientOpts: ClickHouseHttpClientOptions = {
        url: config.url,
        database: config.database,
        user: config.user,
        password: config.password,
      }
      if (options?.fetch) clientOpts.fetch = options.fetch
      if (options?.insertTimeoutMs !== undefined) {
        clientOpts.insertTimeoutMs = options.insertTimeoutMs
      }
      if (options?.queryTimeoutMs !== undefined) {
        clientOpts.queryTimeoutMs = options.queryTimeoutMs
      }
      if (options?.schemaTimeoutMs !== undefined) {
        clientOpts.schemaTimeoutMs = options.schemaTimeoutMs
      }
      this.#client = new ClickHouseHttpClient(clientOpts)
    }
  }

  /**
   * Insert an already-batched array as one `JSONEachRow` request.
   * The collector batches (see the daemon-side collector phase); this store
   * never splits or re-batches, and never inserts per event.
   */
  async ingest(events: readonly ContainerLogEvent[]): Promise<void> {
    if (events.length === 0) return
    const rows = events.map((event) => buildContainerLogRow(event))
    await this.ensureSchema()
    await this.#client.insertRows(CONTAINER_LOGS_TABLE, rows)
  }

  async query(q: ContainerLogQuery): Promise<ContainerLogPage> {
    await this.ensureSchema()

    const from = assertIsoTimestamp('from', q.from)
    const to = assertIsoTimestamp('to', q.to)
    assertRange(from, to)
    const limit = resolveContainerLogQueryLimit(q.limit)

    const params: Record<string, string | number> = {
      organizationId: assertUuid('organizationId', q.organizationId),
      from: toClickHouseDateTime64(from),
      to: toClickHouseDateTime64(to),
      limit,
    }
    const conditions = [
      'organization_id = {organizationId:UUID}',
      'timestamp >= {from:DateTime64(3)}',
      'timestamp < {to:DateTime64(3)}',
    ]

    if (q.serverId !== undefined) {
      params.serverId = assertUuid('serverId', q.serverId)
      conditions.push('server_id = {serverId:UUID}')
    }
    if (q.environmentId !== undefined) {
      params.environmentId = assertUuid('environmentId', q.environmentId)
      conditions.push('environment_id = {environmentId:UUID}')
    }
    if (q.serviceId !== undefined) {
      params.serviceId = assertUuid('serviceId', q.serviceId)
      conditions.push('service_id = {serviceId:UUID}')
    }
    if (q.containerId !== undefined) {
      params.containerId = q.containerId
      conditions.push('container_id = {containerId:String}')
    }
    if (q.stream !== undefined) {
      params.stream = assertStream(q.stream)
      conditions.push('stream = {stream:String}')
    }
    if (q.search !== undefined && q.search !== '') {
      params.search = `%${escapeLikePattern(q.search)}%`
      conditions.push('message ILIKE {search:String}')
    }

    // Keyset pagination on `timestamp` alone.
    //
    // Known limitation: ClickHouse gives us no stable per-row tie-break here
    // (there is no monotonic insert sequence in the table, and adding one would
    // cost a column on every row), so a page boundary that lands *inside* a run
    // of rows sharing one millisecond drops the remainder of that run. In
    // practice container output at millisecond granularity rarely collides
    // across an exact page boundary, and the alternative — an offset scan —
    // degrades badly over a retention window. Documented rather than hidden;
    // the Iceberg backend will carry a real sequence column.
    if (q.cursor !== undefined && q.cursor !== '') {
      const cursorAt = decodeContainerLogCursor(q.cursor)
      params.cursor = toClickHouseDateTime64(cursorAt)
      conditions.push('timestamp < {cursor:DateTime64(3)}')
    }

    const sql = [
      'SELECT',
      '    toString(timestamp) AS timestamp,',
      '    toString(organization_id) AS organization_id,',
      '    toString(server_id) AS server_id,',
      '    environment_id,',
      '    service_id,',
      '    container_id,',
      '    stream,',
      '    message',
      `FROM ${CONTAINER_LOGS_TABLE}`,
      `WHERE ${conditions.join('\n  AND ')}`,
      'ORDER BY timestamp DESC',
      'LIMIT {limit:UInt32}',
    ].join('\n')

    const rows = await this.#client.query<Record<string, unknown>>(sql, params)
    const events = rows.map((row) => parseContainerLogRow(row))
    const last = events.at(-1)
    const nextCursor =
      events.length >= limit && last ? encodeContainerLogCursor(last.timestamp) : null
    return { events, nextCursor }
  }

  /** Idempotent schema ensure — at most once per process (in-flight coalesced). */
  ensureSchema(): Promise<void> {
    if (this.#schemaReady) return Promise.resolve()
    if (this.#schemaPromise !== null) return this.#schemaPromise
    this.#schemaPromise = this.#runEnsureSchema()
      .then(() => {
        this.#schemaReady = true
      })
      .finally(() => {
        this.#schemaPromise = null
      })
    return this.#schemaPromise
  }

  async #runEnsureSchema(): Promise<void> {
    const statements = buildContainerLogSchemaStatements({
      retentionDays: this.#retentionDays,
    })
    for (const sql of statements) {
      await this.#client.exec(sql)
    }
  }
}

/** Map one event to a `JSONEachRow` row. Values are JSON — never SQL-concatenated. */
export function buildContainerLogRow(event: ContainerLogEvent): Record<string, unknown> {
  return {
    timestamp: toClickHouseDateTime64(assertIsoTimestamp('timestamp', event.timestamp)),
    organization_id: assertUuid('organizationId', event.organizationId),
    server_id: assertUuid('serverId', event.serverId),
    environment_id:
      event.environmentId === null ? null : assertUuid('environmentId', event.environmentId),
    service_id: event.serviceId === null ? null : assertUuid('serviceId', event.serviceId),
    container_id: event.containerId,
    stream: assertStream(event.stream),
    message: truncateContainerLogMessage(event.message),
  }
}

/** Parse one `JSONEachRow` row back into the storage-agnostic contract shape. */
export function parseContainerLogRow(row: Record<string, unknown>): ContainerLogEvent {
  return {
    timestamp: fromClickHouseDateTime64(containerLogRowText(row.timestamp)),
    organizationId: containerLogRowText(row.organization_id),
    serverId: containerLogRowText(row.server_id),
    environmentId: row.environment_id == null ? null : containerLogRowText(row.environment_id),
    serviceId: row.service_id == null ? null : containerLogRowText(row.service_id),
    containerId: containerLogRowText(row.container_id),
    stream: row.stream === 'stderr' ? 'stderr' : 'stdout',
    message: containerLogRowText(row.message),
  }
}

/** Opaque, URL-safe page cursor. Content is an implementation detail. */
export function encodeContainerLogCursor(isoTimestamp: string): string {
  return btoa(isoTimestamp)
}

export function decodeContainerLogCursor(cursor: string): Date {
  let decoded: string
  try {
    decoded = atob(cursor)
  } catch {
    throw new TypeError(`invalid container log cursor: ${cursor}`)
  }
  return assertIsoTimestamp('cursor', decoded)
}

function toClickHouseDateTime64(date: Date): string {
  return date.toISOString().replace('T', ' ').replaceAll('Z', '')
}

function fromClickHouseDateTime64(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}

/** Escape LIKE wildcards so a user's `%` / `_` matches literally. */
function escapeLikePattern(value: string): string {
  return value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('%', String.raw`\%`)
    .replaceAll('_', String.raw`\_`)
}

function assertStream(stream: ContainerLogStream): ContainerLogStream {
  if (stream !== 'stdout' && stream !== 'stderr') {
    throw new TypeError(`invalid container log stream: ${String(stream)}`)
  }
  return stream
}

function assertUuid(label: string, value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`invalid ${label} for ClickHouse: ${value}`)
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

function assertRange(from: Date, to: Date): void {
  if (to.getTime() - from.getTime() < 0) {
    throw new TypeError('from must be <= to')
  }
}
