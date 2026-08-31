/**
 * `duckdb-smoke` subcommand of the production instance entry ({@link ./deno.ts})
 * — the in-binary half of `deno task duckdb:smoke`
 * (scripts/duckdb-compile-smoke.ts). Running it through the real compiled
 * artifact (`deno task compile` → `dist/turbopanel-instance`) proves the
 * `@duckdb/node-api` native addon survives TurboPanel's actual build and
 * permission shape before any metrics-store code lands. Modes:
 *
 *   write   — create/open `<metricsDir>/smoke.duckdb`, insert rows
 *   verify  — fresh process: assert the rows persisted (restart durability)
 *   parquet — `COPY ... TO (FORMAT PARQUET)` and read the file back
 */
import { DuckDBInstance } from '@duckdb/node-api'
import { resolveMetricsDir } from './server-paths.ts'

export async function runDuckdbSmoke(mode: string): Promise<void> {
  const metricsDir = resolveMetricsDir()
  await Deno.mkdir(metricsDir, { recursive: true })
  const dbPath = `${metricsDir}/smoke.duckdb`
  const parquetPath = `${metricsDir}/smoke-export.parquet`

  const instance = await DuckDBInstance.create(dbPath)
  const connection = await instance.connect()

  try {
    switch (mode) {
      case 'write': {
        await connection.run(
          'CREATE TABLE IF NOT EXISTS smoke (id INTEGER, label VARCHAR)',
        )
        await connection.run("INSERT INTO smoke VALUES (1, 'alpha'), (2, 'beta')")
        const reader = await connection.runAndReadAll(
          'SELECT count(*) AS n FROM smoke',
        )
        console.log(`smoke:write rows=${reader.getRows()[0][0]}`)
        break
      }
      case 'verify': {
        const reader = await connection.runAndReadAll(
          'SELECT count(*) AS n FROM smoke',
        )
        const rows = Number(reader.getRows()[0][0])
        if (rows < 2) throw new Error(`rows did not persist across restart: ${rows}`)
        console.log(`smoke:verify rows=${rows}`)
        break
      }
      case 'parquet': {
        await connection.run(
          `COPY (SELECT * FROM smoke) TO '${parquetPath}' (FORMAT PARQUET)`,
        )
        const reader = await connection.runAndReadAll(
          `SELECT count(*) AS n FROM read_parquet('${parquetPath}')`,
        )
        const rows = Number(reader.getRows()[0][0])
        if (rows < 2) throw new Error(`parquet round-trip lost rows: ${rows}`)
        console.log(`smoke:parquet rows=${rows}`)
        break
      }
      default:
        throw new TypeError(`unknown smoke mode: ${mode}`)
    }
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
  console.log(`smoke:ok ${mode}`)
}
