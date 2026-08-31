import type { Env, Hono } from 'hono'
import { getActiveServerMetricsStore } from '../daemon/metrics/active-store.ts'
import {
  DuckDbParquetServerMetricsStore,
} from '../daemon/metrics/backends/duckdb/store.ts'

type ResolveStore = () => unknown

/**
 * Deno-only: start the embedded DuckDB UI inside the live metrics store's own
 * DuckDB instance (`LOAD ui` + `start_ui_server()` on the store connection —
 * never a second process against the database file, which would be a second
 * writer). The UI listens on loopback only (default port 4213); the dev
 * console opens the browser after this returns.
 */
export function registerMetricsDuckDbUiRoutes<E extends Env>(
  developer: Hono<E>,
  opts?: { resolveStore?: ResolveStore },
): void {
  const resolveStore = opts?.resolveStore ?? getActiveServerMetricsStore
  developer.post('/metrics/duckdb-ui', async (c) => {
    const store = resolveStore()
    if (!(store instanceof DuckDbParquetServerMetricsStore)) {
      return c.json(
        {
          ok: false,
          error: 'DuckDB metrics store is not active (Deno runtime only)',
        },
        503,
      )
    }
    try {
      const started = await store.startUiServer()
      return c.json({ ok: true, port: started.port })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json(
        { ok: false, error: `failed to start DuckDB UI: ${message}` },
        500,
      )
    }
  })
}
