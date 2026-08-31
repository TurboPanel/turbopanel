import { DuckDbParquetServerMetricsStore } from "./backends/duckdb/store.ts";
import type { ServerMetricsStore } from "./types.ts";
import {
  type ResolveServerMetricsStoreInput,
  UnavailableServerMetricsStore,
  warnMetricsStoreSelectionOnce,
} from "./store-selection-core.ts";
import { resolveServerMetricsStore as resolveWorkersServerMetricsStore } from "./store-selection-workers.ts";

export type {
  AnalyticsEngineDatasetLike,
  CloudflareAnalyticsSqlConfig,
  MetricsEnvValue,
  ResolveServerMetricsStoreInput,
} from "./store-selection-core.ts";
export {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  parseAnalyticsEngineMaxRangeSeconds,
  parseMetricsRetentionDays,
  parsePositiveIntEnv,
  resetMetricsStoreSelectionWarningsForTests,
  resolveCloudflareAnalyticsSqlConfig,
  UnavailableServerMetricsStore,
} from "./store-selection-core.ts";

/**
 * Select the host metrics store for the current runtime.
 * Server metrics are always on — there is no enable/disable gate.
 * Workers → Analytics Engine; Deno → DuckDB.
 * Only a genuinely unconfigured backend (Workers without the AE binding)
 * falls back to the disabled no-op store; an attempted backend that fails
 * to open resolves to a store whose reads reject, so metrics routes return
 * 503 `metrics_backend_unavailable` instead of hiding the outage.
 */
export function resolveServerMetricsStore(
  input: ResolveServerMetricsStoreInput,
): ServerMetricsStore {
  if (input.runtime === "workers") {
    return resolveWorkersServerMetricsStore(input);
  }

  // Deno → DuckDB, always: the metrics directory derives from
  // `resolveMetricsDir()` with a filesystem default, so there is no
  // "incomplete config" case — only a directory that cannot be created.
  try {
    return new DuckDbParquetServerMetricsStore(input.duckdb ?? {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A DuckDB startup failure is a self-hosted backend outage, never an
    // "unconfigured" state — reads must surface 503, not the disabled store.
    warnMetricsStoreSelectionOnce(
      "deno-missing-duckdb",
      `server metrics on Deno but DuckDB store failed to open; metrics reads will return 503 (${message})`,
    );
    return new UnavailableServerMetricsStore(
      `DuckDB metrics store failed to open: ${message}`,
    );
  }
}
