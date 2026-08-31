/**
 * Production Deno entry. Does not import developer modules so `deno task compile`
 * keeps those routes, git/tar/node grants, and Drizzle Studio out of the binary.
 * Development source mode uses {@link ./deno-dev.ts}.
 *
 * `duckdb-smoke <write|verify|parquet>` runs the embedded-DuckDB packaging
 * probe instead of starting the server, so `deno task duckdb:smoke`
 * (scripts/duckdb-compile-smoke.ts) exercises the exact compiled artifact
 * that ships. Imported lazily: the server path must not load the DuckDB
 * native addon at startup.
 */
import { startDenoServer } from './deno-server.ts'

if (Deno.args[0] === 'duckdb-smoke') {
  const { runDuckdbSmoke } = await import('./duckdb-smoke.ts')
  await runDuckdbSmoke(Deno.args[1] ?? '')
} else {
  await startDenoServer()
}
