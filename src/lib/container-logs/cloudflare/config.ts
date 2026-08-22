/**
 * Cloudflare (Pipelines → R2 Data Catalog → R2 SQL) container-log config.
 *
 * Styled after `resolveAnalyticsEngineSqlConfig`
 * (`src/daemon/metrics/store-selection.ts`): read the Workers env, return
 * `null` the moment anything required is missing, and let the selector fall
 * back to the disabled store rather than throwing. A half-converged deployment
 * still runs containers — it just does not retain their output.
 *
 * Both R2 Data Catalog and R2 SQL are Cloudflare **public-beta** products, so
 * every code path that touches them must degrade gracefully.
 *
 * ## No scanned-bytes budget exists — so this path fails closed
 *
 * R2 SQL bills on **compressed bytes scanned** (10 MB minimum per query), but
 * its HTTP query API accepts exactly one field — `{ "query": "…" }`. There is
 * no `max_bytes_scanned`, no cost cap, and no timeout knob to send. So this
 * config deliberately carries **no bytes budget**: we cannot enforce one, and
 * a field that silently did nothing would be worse than its absence. If
 * Cloudflare ships one, add it here *and* to the `executeR2Sql` body in the
 * same change, and relax the guards below to match.
 *
 * Because no hard ceiling can be sent, the guards that *can* run before the
 * request leaves the process are deliberately conservative rather than
 * generous:
 *
 * - **Row count** — `resolveContainerLogQueryLimit` (`../types.ts`).
 * - **Time window** — {@link ContainerLogsCloudflareConfig.maxRangeSeconds},
 *   defaulted to {@link CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS}
 *   (24 hours), **not** the 30-day retention window. A read wider than a day
 *   has to be asked for explicitly by the operator.
 * - **Selectivity** — a query carrying no `serverId` / `serviceId` /
 *   `containerId` prunes no Iceberg data files beyond the time partition, so
 *   its window is capped much harder still
 *   ({@link ContainerLogsCloudflareConfig.maxUnselectiveRangeSeconds},
 *   default one hour). Past that, the read is **refused** rather than issued
 *   uncapped — see `pipeline-store.ts`.
 *
 * The first two remain proxies for scan cost, not ceilings on it: actual bytes
 * scanned still depend on data-file sizes and compaction state. The real
 * operational guardrail is still "enable compaction and keep the window
 * narrow"; these guards exist so an accidental wide read cannot bill without
 * anyone choosing it.
 *
 * @see https://developers.cloudflare.com/r2-sql/query-data/
 * @see https://developers.cloudflare.com/r2-sql/platform/pricing/
 */

import { CONTAINER_LOG_RETENTION_DAYS } from '../types.ts'

/** `namespace.table` of the Iceberg table when the env does not name one. */
export const DEFAULT_CONTAINER_LOGS_ICEBERG_TABLE = 'default.container_logs'

/**
 * Default safety-net max query window: **24 hours**.
 *
 * Deliberately *not* the 30-day retention window. Aligning the two would mean
 * the default read budget on a backend with no scanned-bytes ceiling is "every
 * byte we retain", which is exactly the read nobody intends to pay for. A day
 * covers the interactive question this UI actually asks ("what did this service
 * print recently"); anything wider is an operator decision, made explicitly via
 * `TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_RANGE_SECONDS`.
 */
export const CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS = 24 * 60 * 60

/** The retention window, for callers that want to opt back up to it knowingly. */
export const CONTAINER_LOGS_R2_SQL_RETENTION_RANGE_SECONDS =
  CONTAINER_LOG_RETENTION_DAYS * 24 * 60 * 60

/**
 * Default max window for a query with **no selective predicate**: one hour.
 *
 * `organization_id` alone prunes nothing in an Iceberg table partitioned on
 * time — such a read scans every file in the window for every server the
 * tenant owns. With no byte ceiling to send, the only fail-closed answer is to
 * keep that window very small and refuse anything wider. Override with
 * `TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_UNSELECTIVE_RANGE_SECONDS`.
 */
export const CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS = 60 * 60

export type ContainerLogsCloudflareConfig = {
  accountId: string
  /**
   * API token with R2 SQL + R2 Data Catalog + R2 storage read permissions.
   * A **secret**, never a `vars` entry — same handling as
   * `TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN`.
   */
  apiToken: string
  /** R2 bucket backing the Data Catalog warehouse (the URL path segment). */
  bucket: string
  /** Fully-qualified `namespace.table` identifier of the Iceberg table. */
  table: string
  /**
   * Max allowed `to - from` span in seconds for a **selective** query (one
   * carrying `serverId`, `serviceId`, or `containerId`).
   *
   * A time-window bound, **not** a scanned-bytes ceiling — R2 SQL exposes no
   * byte cap to send (see the module note). Defaults to
   * {@link CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS}.
   */
  maxRangeSeconds?: number
  /**
   * Max allowed span for a query with **no** selective predicate.
   *
   * Such a read cannot prune data files beyond the time partition, so it is
   * the one most able to run away on a backend that accepts no cost ceiling.
   * Defaults to {@link CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS}.
   */
  maxUnselectiveRangeSeconds?: number
  /** Injected for tests. */
  fetch?: typeof fetch
}

/** Workers env subset this resolver reads. */
export type ContainerLogsCloudflareEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string
  TURBOPANEL_CONTAINER_LOGS_R2_SQL_API_TOKEN?: string
  TURBOPANEL_CONTAINER_LOGS_R2_SQL_BUCKET?: string
  TURBOPANEL_CONTAINER_LOGS_ICEBERG_TABLE?: string
  TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_RANGE_SECONDS?: string | number
  TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_UNSELECTIVE_RANGE_SECONDS?: string | number
}

/** Parse an optional positive-integer seconds override. */
export function parseContainerLogsMaxRangeSeconds(
  value: string | number | undefined | null
): number | undefined {
  if (value === undefined || value === null) return undefined
  const normalized = String(value).trim()
  if (!normalized) return undefined
  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

/**
 * Resolve R2 SQL read credentials + the Iceberg table identity from Workers env.
 *
 * Returns `null` when the account id, token, or bucket is missing. The table
 * identifier has a documented default because it is a naming convention we
 * control, not a credential.
 */
export function resolveContainerLogsCloudflareConfig(
  env: ContainerLogsCloudflareEnv
): ContainerLogsCloudflareConfig | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.TURBOPANEL_CONTAINER_LOGS_R2_SQL_API_TOKEN?.trim()
  const bucket = env.TURBOPANEL_CONTAINER_LOGS_R2_SQL_BUCKET?.trim()
  if (!accountId || !apiToken || !bucket) return null
  const table =
    env.TURBOPANEL_CONTAINER_LOGS_ICEBERG_TABLE?.trim() || DEFAULT_CONTAINER_LOGS_ICEBERG_TABLE
  const maxRangeSeconds =
    parseContainerLogsMaxRangeSeconds(env.TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_RANGE_SECONDS) ??
    CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS
  // Never wider than the selective bound: an "unselective" read is strictly
  // more expensive, so a misconfigured override must not invert the two.
  const maxUnselectiveRangeSeconds = Math.min(
    parseContainerLogsMaxRangeSeconds(
      env.TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_UNSELECTIVE_RANGE_SECONDS
    ) ?? CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS,
    maxRangeSeconds
  )
  return { accountId, apiToken, bucket, table, maxRangeSeconds, maxUnselectiveRangeSeconds }
}
