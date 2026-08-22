/**
 * Select the container-log store for the current runtime.
 *
 * Mirrors `resolveServerMetricsStore` (`src/daemon/metrics/store-selection.ts`)
 * and `resolveExecutionLogStore` (`../execution-logs/store-selection.ts`):
 * runtime-branch first, `warnOnce` on incomplete configuration, and a disabled
 * no-op store rather than a throw so a half-converged deployment still runs
 * containers — it just does not retain their output.
 *
 * **One difference, on purpose:** container logs are **default-off**. Host
 * metrics have no enable gate (they are always on); container logs are opt-in
 * because they are high-volume and the operator chooses to pay for them. When
 * `enabled` is falsy this returns the disabled store unconditionally, whatever
 * the runtime or how complete the backend config is.
 */

import { ClickHouseContainerLogStore } from './clickhouse/store.ts'
import type { ClickHouseContainerLogStoreConfig } from './clickhouse/store.ts'
import type { ContainerLogsCloudflareConfig } from './cloudflare/config.ts'
import { PipelinesIcebergContainerLogStore } from './cloudflare/pipeline-store.ts'
import type { PipelineLike } from './cloudflare/pipeline-store.ts'
import { DisabledContainerLogStore } from './disabled-store.ts'
import { CONTAINER_LOG_RETENTION_DAYS, type ContainerLogStore } from './types.ts'

export { resolveContainerLogsCloudflareConfig } from './cloudflare/config.ts'
export type { ContainerLogsCloudflareEnv } from './cloudflare/config.ts'
export type { ContainerLogsCloudflareConfig, PipelineLike }

/**
 * True when the resolved store retains nothing.
 *
 * Ingest callers must not branch on this (dropping is the documented no-op),
 * but a **read** route needs it: an empty page is indistinguishable from "you
 * turned this off", so `GET …/container-logs` answers 503 with an explicit
 * `container_logs_disabled` code instead of pretending the tenant simply has
 * no output.
 */
export function isDisabledContainerLogStore(store: ContainerLogStore): boolean {
  return store instanceof DisabledContainerLogStore
}

const warnedKeys = new Set<string>()

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(message)
}

/** Test seam: clear warn-once keys. */
export function resetContainerLogStoreSelectionWarningsForTests(): void {
  warnedKeys.clear()
}

/** Parse the opt-in flag. Anything other than a truthy token stays off. */
export function parseContainerLogsEnabled(
  value: string | number | boolean | undefined | null
): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

/** Parse an optional positive-integer retention override. */
export function parseContainerLogRetentionDays(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return CONTAINER_LOG_RETENTION_DAYS
  const parsed = Number(String(value).trim())
  if (!Number.isInteger(parsed) || parsed <= 0) return CONTAINER_LOG_RETENTION_DAYS
  return parsed
}

type PartialClickHouseConfig = {
  url?: string | null
  database?: string | null
  user?: string | null
  password?: string | null
  retentionDays?: number | null
}

/**
 * Duplicated from the metrics selector on purpose — container logs must not
 * depend on the metrics module's private helpers.
 */
function isFullClickHouseConfig(
  config: PartialClickHouseConfig | undefined
): config is PartialClickHouseConfig & ClickHouseContainerLogStoreConfig {
  if (!config) return false
  return Boolean(
    config.url?.trim() &&
    config.database?.trim() &&
    config.user?.trim() &&
    config.password != null &&
    String(config.password).length > 0
  )
}

export type ResolveContainerLogStoreInput = {
  runtime: 'workers' | 'deno'
  /** Opt-in gate. Falsy → disabled store, always. */
  enabled: boolean
  clickhouse?: PartialClickHouseConfig
  /** Workers Pipelines binding (`env.CONTAINER_LOGS`). */
  pipeline?: PipelineLike
  /** R2 SQL read config — `resolveContainerLogsCloudflareConfig(env)`. */
  r2Sql?: ContainerLogsCloudflareConfig | null
}

/**
 * Deno + enabled + complete ClickHouse config → `ClickHouseContainerLogStore`.
 * Workers + enabled + a Pipelines binding + complete R2 SQL config →
 * `PipelinesIcebergContainerLogStore`.
 * Everything else → `DisabledContainerLogStore` (with a one-time warning when
 * the operator asked for container logs but nothing can serve them, so a
 * misconfiguration is visible instead of silent data loss).
 */
export function resolveContainerLogStore(input: ResolveContainerLogStoreInput): ContainerLogStore {
  if (!input.enabled) return new DisabledContainerLogStore()

  if (input.runtime === 'workers') {
    if (input.pipeline && input.r2Sql) {
      return new PipelinesIcebergContainerLogStore(input.pipeline, input.r2Sql)
    }
    warnOnce(
      'workers-incomplete-cloudflare',
      'container logs are enabled on Workers but the Pipelines/R2 SQL config is ' +
        'incomplete; container output will not be retained'
    )
    return new DisabledContainerLogStore()
  }

  if (isFullClickHouseConfig(input.clickhouse)) {
    const retentionDays = input.clickhouse.retentionDays ?? undefined
    return new ClickHouseContainerLogStore({
      url: input.clickhouse.url.trim(),
      database: input.clickhouse.database.trim(),
      user: input.clickhouse.user.trim(),
      password: String(input.clickhouse.password),
      ...(retentionDays != null ? { retentionDays } : {}),
    })
  }

  warnOnce(
    'deno-missing-clickhouse',
    'container logs are enabled on Deno but ClickHouse config is incomplete; ' +
      'container output will not be retained'
  )
  return new DisabledContainerLogStore()
}
