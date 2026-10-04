/**
 * DuckDB connection lifecycle for the Deno server-metrics store.
 *
 * One embedded database file under the metrics state root
 * (`resolveMetricsDir()`), opened idempotently with resource caps applied via
 * `SET` statements and the schema ensured once. The returned
 * {@link DuckDbHandle} is shared by the store's write/read paths and the
 * daily Parquet archive job (and, later, the dev-only "Open DuckDB UI"
 * action attaches to this same instance rather than opening a second one).
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { resolveMetricsDir } from '../../../../platform/deno/server-paths.ts'
import { forEachSequential } from '../../../../lib/sequential.ts'
import { buildSchemaStatements, DUCKDB_SCHEMA_MARKER_VERSION } from './schema.ts'

/** One result row as plain JS values (via `getRowObjectsJS`). */
export type DuckDbRow = Record<string, unknown>

/** Bindable prepared-statement parameter values this backend uses. */
export type DuckDbBindValue = null | boolean | number | bigint | string

/**
 * Narrow structural view of `DuckDBConnection` — the injection seam so unit
 * tests can fake a connection without loading the native addon.
 */
export type DuckDbConnectionLike = {
  run(sql: string, values?: DuckDbBindValue[]): Promise<unknown>
  runAndReadAll(
    sql: string,
    values?: DuckDbBindValue[]
  ): Promise<{ getRowObjectsJS(): DuckDbRow[] }>
  closeSync(): void
}

/** Open connection + close for the shared instance lifecycle. */
export type DuckDbHandle = {
  connection: DuckDbConnectionLike
  close(): void
}

export type DuckDbPaths = {
  /** Metrics state root (`resolveMetricsDir()` default). */
  metricsDir: string
  /** Embedded database file (`<metricsDir>/metrics.duckdb`). */
  databasePath: string
  /** Sealed daily partition tree root (`<metricsDir>/parquet`). */
  parquetRoot: string
  /** Spill/tmp directory for DuckDB and in-flight Parquet exports. */
  tmpDir: string
}

/** Resolve all DuckDB metrics paths from an optional metrics-dir override. */
export function resolveDuckDbPaths(metricsDir?: string): DuckDbPaths {
  const root = metricsDir?.trim() || resolveMetricsDir()
  return {
    metricsDir: root,
    databasePath: `${root}/metrics.duckdb`,
    parquetRoot: `${root}/parquet`,
    tmpDir: `${root}/tmp`,
  }
}

/** Sidecar file recording the schema version the store was last opened with. */
export function schemaMarkerPath(paths: DuckDbPaths): string {
  return `${paths.metricsDir}/schema-version`
}

type SchemaMarkerState =
  { kind: 'missing' } | { kind: 'invalid' } | { kind: 'version'; value: number }

/** Marker content, with absent and unparseable told apart. Read errors other than NotFound throw. */
async function readSchemaMarkerState(paths: DuckDbPaths): Promise<SchemaMarkerState> {
  let text: string
  try {
    text = await Deno.readTextFile(schemaMarkerPath(paths))
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: 'missing' }
    throw error
  }
  const trimmed = text.trim()
  const value = Number(trimmed)
  return trimmed !== '' && Number.isInteger(value) && value > 0
    ? { kind: 'version', value }
    : { kind: 'invalid' }
}

/**
 * Marker version recorded by the last successful open, or `null` when no
 * marker exists yet (fresh install) or its content is not a version number.
 */
export async function readSchemaMarker(paths: DuckDbPaths): Promise<number | null> {
  const state = await readSchemaMarkerState(paths)
  return state.kind === 'version' ? state.value : null
}

/**
 * Record the current schema marker — called only after a successful open.
 * Skipped when it already matches; otherwise written to a temp file and
 * renamed so a crash never leaves an empty or partial marker behind.
 */
export async function writeSchemaMarker(paths: DuckDbPaths): Promise<void> {
  if ((await readSchemaMarker(paths)) === DUCKDB_SCHEMA_MARKER_VERSION) return
  const target = schemaMarkerPath(paths)
  const temp = `${target}.tmp`
  await Deno.writeTextFile(temp, String(DUCKDB_SCHEMA_MARKER_VERSION))
  await Deno.rename(temp, target)
}

/** Default DuckDB worker-thread cap applied when no override is given. */
export const DUCKDB_DEFAULT_THREADS = 2

/** Default DuckDB `memory_limit` (MiB) applied when no override is given. */
export const DUCKDB_DEFAULT_MEMORY_LIMIT_MB = 128

export type OpenDuckDbOptions = {
  paths: DuckDbPaths
  /** DuckDB `threads` setting (worker thread cap, default 2). */
  threads?: number
  /** DuckDB `memory_limit` in MiB (default 128). */
  memoryLimitMb?: number
}

/** Escape a string for embedding in a single-quoted DuckDB SQL literal. */
export function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''")
}

/**
 * Open (or create) the current DuckDB metrics store (schema marker 9).
 * A sidecar marker holding an older version number discards
 * `metrics.duckdb`, `parquet/`, `tmp/`, and `schema-version` before this
 * open creates the current layout (no in-place migration). A missing marker
 * beside existing data, or an empty, unparseable, or newer marker, makes the
 * open fail without deleting anything.
 */
export async function openDuckDb(options: OpenDuckDbOptions): Promise<DuckDbHandle> {
  const { paths } = options
  await Deno.mkdir(paths.metricsDir, { recursive: true })
  await discardNonCurrentMetricsStore(paths)

  const instance = await DuckDBInstance.create(paths.databasePath)
  const connection = await instance.connect()

  await Deno.mkdir(paths.parquetRoot, { recursive: true })
  await Deno.mkdir(paths.tmpDir, { recursive: true })

  try {
    // Resource caps always apply — defaults keep an unconfigured self-hosted
    // store within the promised posture (threads 2, memory_limit 128MiB).
    await connection.run(
      `SET threads = ${assertPositiveInt('threads', options.threads ?? DUCKDB_DEFAULT_THREADS)}`
    )
    await connection.run(
      `SET memory_limit = '${assertPositiveInt(
        'memoryLimitMb',
        options.memoryLimitMb ?? DUCKDB_DEFAULT_MEMORY_LIMIT_MB
      )}MiB'`
    )
    await connection.run(`SET temp_directory = '${escapeSqlString(paths.tmpDir)}'`)
    await forEachSequential(buildSchemaStatements(), (statement) => connection.run(statement))
  } catch (error) {
    connection.closeSync()
    instance.closeSync()
    throw error
  }

  await writeSchemaMarker(paths)

  return {
    connection,
    close() {
      connection.closeSync()
      instance.closeSync()
    },
  }
}

/**
 * Current-version-only gate. The store is discarded only when the marker is
 * explicitly an older version number. A missing marker next to existing data,
 * an empty or unreadable marker, or a newer version is refused instead:
 * wiping on ambiguity would let a crash or a permission error erase the
 * whole metrics history.
 */
async function discardNonCurrentMetricsStore(paths: DuckDbPaths): Promise<void> {
  const state = await readSchemaMarkerState(paths)
  if (state.kind === 'version' && state.value === DUCKDB_SCHEMA_MARKER_VERSION) return
  if (state.kind === 'version' && state.value < DUCKDB_SCHEMA_MARKER_VERSION) {
    await removeMetricsStoreFiles(paths)
    return
  }
  if (state.kind === 'missing' && !(await metricsStoreHasData(paths))) return
  throw new Error(
    `DuckDB metrics schema marker at ${schemaMarkerPath(paths)} is ` +
      `${state.kind === 'version' ? `newer (${state.value}) than this build` : state.kind}; ` +
      'refusing to delete the metrics store. Fix or remove the marker, or remove the metrics ' +
      'directory yourself to start fresh.'
  )
}

async function metricsStoreHasData(paths: DuckDbPaths): Promise<boolean> {
  try {
    await Deno.stat(paths.databasePath)
    return true
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  try {
    for await (const _entry of Deno.readDir(paths.parquetRoot)) return true
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return false
}

async function removeMetricsStoreFiles(paths: DuckDbPaths): Promise<void> {
  await removePathIfExists(paths.databasePath)
  await removePathIfExists(`${paths.databasePath}.wal`)
  await removePathIfExists(paths.parquetRoot)
  await removePathIfExists(paths.tmpDir)
  await removePathIfExists(schemaMarkerPath(paths))
}

async function removePathIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true })
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
}

function assertPositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}
