import { AnalyticsEngineServerMetricsStore } from "./analytics-engine/store.ts";
import type { AnalyticsEngineDatasetLike } from "./analytics-engine/store.ts";
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  type AnalyticsEngineSqlConfig,
} from "./analytics-engine/sql-api.ts";
import { ClickHouseServerMetricsStore } from "./clickhouse/store.ts";
import type { ClickHouseStoreConfig } from "./clickhouse/store.ts";
import { DisabledServerMetricsStore } from "./disabled-store.ts";
import type { ServerMetricsStore } from "./types.ts";

export type { AnalyticsEngineDatasetLike, AnalyticsEngineSqlConfig };
export { AE_DEFAULT_MAX_RANGE_SECONDS };

const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

/** Test seam: clear warn-once keys. */
export function resetMetricsStoreSelectionWarningsForTests(): void {
  warnedKeys.clear();
}

export type MetricsEnvValue = string | number | undefined | null;

function parsePositiveIntegerEnvValue(
  value: MetricsEnvValue,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * Parse optional AE max-range override (positive integer seconds).
 * Invalid / empty values fall through to the retention-aligned default.
 */
export const parseAnalyticsEngineMaxRangeSeconds = parsePositiveIntegerEnvValue;

/**
 * Resolve AE SQL API credentials from Workers env.
 * Returns null when account id or token is missing (writes still work).
 * Always sets `maxRangeSeconds` (env override or documented AE retention default)
 * so hosted query APIs can enforce retention without re-patching the store.
 */
export function resolveAnalyticsEngineSqlConfig(
  env: {
    CLOUDFLARE_ACCOUNT_ID?: string;
    TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN?: string;
    TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS?: string | number;
  },
): AnalyticsEngineSqlConfig | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN?.trim();
  if (!accountId || !apiToken) return null;
  const maxRangeSeconds =
    parseAnalyticsEngineMaxRangeSeconds(
      env.TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS,
    ) ?? AE_DEFAULT_MAX_RANGE_SECONDS;
  return { accountId, apiToken, maxRangeSeconds };
}

function isFullClickHouseConfig(
  config: {
    url?: string | null;
    database?: string | null;
    user?: string | null;
    password?: string | null;
    retentionDays?: number | null;
  } | undefined,
): config is ClickHouseStoreConfig {
  if (!config) return false;
  return Boolean(
    config.url?.trim() &&
      config.database?.trim() &&
      config.user?.trim() &&
      config.password != null &&
      String(config.password).length > 0,
  );
}

/**
 * Parse optional metrics retention days (positive integer).
 * Invalid / empty values fall through to the schema default (90).
 */
export const parseMetricsRetentionDays = parsePositiveIntegerEnvValue;

export type ResolveServerMetricsStoreInput = {
  runtime: "workers" | "deno";
  analyticsEngine?: AnalyticsEngineDatasetLike;
  /** AE SQL API credentials (Workers query path). */
  analyticsEngineSql?: AnalyticsEngineSqlConfig | null;
  clickhouse?: {
    url?: string | null;
    database?: string | null;
    user?: string | null;
    password?: string | null;
    retentionDays?: number | null;
  };
};

/**
 * Select the host metrics store for the current runtime.
 * Server metrics are always on — there is no enable/disable gate.
 * Workers → Analytics Engine; Deno → ClickHouse.
 * Incomplete backend config falls back to a no-op store until converge wires it.
 */
export function resolveServerMetricsStore(
  input: ResolveServerMetricsStoreInput,
): ServerMetricsStore {
  if (input.runtime === "workers") {
    if (input.analyticsEngine) {
      return new AnalyticsEngineServerMetricsStore(input.analyticsEngine, {
        sql: input.analyticsEngineSql ?? undefined,
      });
    }
    warnOnce(
      "workers-missing-ae",
      "server metrics on Workers but SERVER_METRICS binding missing; using unconfigured store",
    );
    return new DisabledServerMetricsStore();
  }

  if (isFullClickHouseConfig(input.clickhouse)) {
    const retentionDays = input.clickhouse.retentionDays ?? undefined;
    return new ClickHouseServerMetricsStore({
      url: input.clickhouse.url.trim(),
      database: input.clickhouse.database.trim(),
      user: input.clickhouse.user.trim(),
      password: String(input.clickhouse.password),
      ...(retentionDays != null ? { retentionDays } : {}),
    });
  }
  warnOnce(
    "deno-missing-clickhouse",
    "server metrics on Deno but ClickHouse config incomplete; using unconfigured store",
  );
  return new DisabledServerMetricsStore();
}
