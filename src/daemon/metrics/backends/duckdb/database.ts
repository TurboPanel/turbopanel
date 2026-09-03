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

import { DuckDBInstance } from "@duckdb/node-api";
import { resolveMetricsDir } from "../../../../server-paths.ts";
import {
  buildSchemaStatements,
  DUCKDB_SCHEMA_MARKER_VERSION,
  HOST_METRICS_TABLE,
} from "./schema.ts";

/** One result row as plain JS values (via `getRowObjectsJS`). */
export type DuckDbRow = Record<string, unknown>;

/** Bindable prepared-statement parameter values this backend uses. */
export type DuckDbBindValue = null | boolean | number | bigint | string;

/**
 * Narrow structural view of `DuckDBConnection` — the injection seam so unit
 * tests can fake a connection without loading the native addon.
 */
export type DuckDbConnectionLike = {
  run(sql: string, values?: DuckDbBindValue[]): Promise<unknown>;
  runAndReadAll(
    sql: string,
    values?: DuckDbBindValue[],
  ): Promise<{ getRowObjectsJS(): DuckDbRow[] }>;
  closeSync(): void;
};

/** Open connection + close for the shared instance lifecycle. */
export type DuckDbHandle = {
  connection: DuckDbConnectionLike;
  close(): void;
};

export type DuckDbPaths = {
  /** Metrics state root (`resolveMetricsDir()` default). */
  metricsDir: string;
  /** Embedded database file (`<metricsDir>/metrics.duckdb`). */
  databasePath: string;
  /** Sealed daily partition tree root (`<metricsDir>/parquet`). */
  parquetRoot: string;
  /** Spill/tmp directory for DuckDB and in-flight Parquet exports. */
  tmpDir: string;
};

/** Resolve all DuckDB metrics paths from an optional metrics-dir override. */
export function resolveDuckDbPaths(metricsDir?: string): DuckDbPaths {
  const root = metricsDir?.trim() || resolveMetricsDir();
  return {
    metricsDir: root,
    databasePath: `${root}/metrics.duckdb`,
    parquetRoot: `${root}/parquet`,
    tmpDir: `${root}/tmp`,
  };
}

/** Sidecar file recording the schema version the store was last opened with. */
export function schemaMarkerPath(paths: DuckDbPaths): string {
  return `${paths.metricsDir}/schema-version`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Marker version recorded by the last successful open, or `null` when no
 * marker exists yet (fresh install, or a pre-marker store).
 */
export async function readSchemaMarker(
  paths: DuckDbPaths,
): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(schemaMarkerPath(paths));
    const value = Number(text.trim());
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** Record the current schema marker — called only after a successful open. */
export async function writeSchemaMarker(paths: DuckDbPaths): Promise<void> {
  await Deno.writeTextFile(
    schemaMarkerPath(paths),
    String(DUCKDB_SCHEMA_MARKER_VERSION),
  );
}

/**
 * True when the on-disk store must be wiped before it's opened, decided from
 * the actual store artifacts rather than the sidecar marker alone:
 *
 * - No database file: staleness can only come from a leftover pre-v3
 *   `parquet/` tree (`parquetHasData`) — a bare fresh install is never wiped.
 * - A database file exists: staleness is decided by `schemaIsCurrent` (the
 *   probed on-disk columns), never by the marker's mere absence — a current
 *   v3 store with a missing/corrupt marker must not be destroyed.
 */
export function shouldWipeStaleStore(input: {
  databaseExists: boolean;
  schemaIsCurrent: boolean;
  parquetHasData: boolean;
}): boolean {
  if (!input.databaseExists) return input.parquetHasData;
  return !input.schemaIsCurrent;
}

/**
 * True when the probed column set already carries the v3 marker columns.
 * An empty column list means the table itself doesn't exist yet (a fresh or
 * half-built file) — that's never stale, since the schema DDL builds it.
 */
export function schemaIsCurrentFromColumns(
  columnNames: readonly string[],
): boolean {
  if (columnNames.length === 0) return true;
  const set = new Set(columnNames);
  return set.has("parts") && set.has("hardware_profile_generation");
}

/** Probe the live connection's on-disk columns for the v3 marker columns. */
async function probeSchemaIsCurrent(
  connection: DuckDbConnectionLike,
): Promise<boolean> {
  const reader = await connection.runAndReadAll(
    `SELECT column_name FROM information_schema.columns ` +
      `WHERE table_name = '${HOST_METRICS_TABLE}'`,
  );
  const columnNames = reader.getRowObjectsJS().map((row) =>
    String(row.column_name)
  );
  return schemaIsCurrentFromColumns(columnNames);
}

/**
 * True when at least one `.parquet` file exists anywhere under `root`
 * (recursive). A missing root (fresh install) is not an error — it just
 * means no archived data survived.
 */
async function parquetTreeHasFiles(root: string): Promise<boolean> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile && entry.name.endsWith(".parquet")) return true;
    if (
      entry.isDirectory &&
      (await parquetTreeHasFiles(`${root}/${entry.name}`))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Delete the stale database file (+ WAL) and the entire Parquet partition
 * tree. Both must go together: a surviving pre-v3 partition would union back
 * in via `read_parquet(..., union_by_name = true)` with the new columns
 * NULL-filled, reintroducing the exact "absent vs. null" ambiguity the
 * schema bump exists to resolve. Called both when an existing database is
 * genuinely stale and when no database survived but a pre-v3 `parquet/` tree
 * did — either way, nothing pre-v3 may remain.
 */
export async function wipeStaleStore(paths: DuckDbPaths): Promise<void> {
  console.warn(
    `duckdb metrics store: wiping stale schema at ${paths.metricsDir} ` +
      `(expected marker v${DUCKDB_SCHEMA_MARKER_VERSION})`,
  );
  await Deno.remove(paths.databasePath).catch(() => {});
  await Deno.remove(`${paths.databasePath}.wal`).catch(() => {});
  await Deno.remove(paths.parquetRoot, { recursive: true }).catch(() => {});
}

/** Default DuckDB worker-thread cap applied when no override is given. */
export const DUCKDB_DEFAULT_THREADS = 2;

/** Default DuckDB `memory_limit` (MiB) applied when no override is given. */
export const DUCKDB_DEFAULT_MEMORY_LIMIT_MB = 128;

export type OpenDuckDbOptions = {
  paths: DuckDbPaths;
  /** DuckDB `threads` setting (worker thread cap, default 2). */
  threads?: number;
  /** DuckDB `memory_limit` in MiB (default 128). */
  memoryLimitMb?: number;
};

/** Escape a string for embedding in a single-quoted DuckDB SQL literal. */
export function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Open (or create) the metrics database: ensure the directory tree exists,
 * apply resource caps via `SET`, and run the idempotent schema DDL.
 */
export async function openDuckDb(
  options: OpenDuckDbOptions,
): Promise<DuckDbHandle> {
  const { paths } = options;
  await Deno.mkdir(paths.metricsDir, { recursive: true });

  const databaseExists = await fileExists(paths.databasePath);

  // Opening (or creating) the instance is needed either way: to probe an
  // existing file's actual columns, or as the fresh-install open itself.
  let instance = await DuckDBInstance.create(paths.databasePath);
  let connection = await instance.connect();

  let wipeStale: boolean;
  if (databaseExists) {
    const markerVersion = await readSchemaMarker(paths);
    // Trust a current marker outright (it's only ever written after a
    // successful v3 open) — otherwise probe the actual on-disk columns
    // rather than treating a missing/corrupt marker as proof of staleness.
    // A probe failure (corrupt file, foreign storage format) is itself
    // treated as stale so the wipe below can rebuild a usable store.
    const schemaIsCurrent = markerVersion === DUCKDB_SCHEMA_MARKER_VERSION
      ? true
      : await probeSchemaIsCurrent(connection).catch(() => false);
    wipeStale = shouldWipeStaleStore({
      databaseExists: true,
      schemaIsCurrent,
      parquetHasData: false,
    });
  } else {
    const parquetHasData = await parquetTreeHasFiles(paths.parquetRoot);
    wipeStale = shouldWipeStaleStore({
      databaseExists: false,
      schemaIsCurrent: true,
      parquetHasData,
    });
  }

  if (wipeStale) {
    connection.closeSync();
    instance.closeSync();
    await wipeStaleStore(paths);
    instance = await DuckDBInstance.create(paths.databasePath);
    connection = await instance.connect();
  }

  await Deno.mkdir(paths.parquetRoot, { recursive: true });
  await Deno.mkdir(paths.tmpDir, { recursive: true });

  try {
    // Resource caps always apply — defaults keep an unconfigured self-hosted
    // store within the promised posture (threads 2, memory_limit 128MiB).
    await connection.run(
      `SET threads = ${
        assertPositiveInt("threads", options.threads ?? DUCKDB_DEFAULT_THREADS)
      }`,
    );
    await connection.run(
      `SET memory_limit = '${
        assertPositiveInt(
          "memoryLimitMb",
          options.memoryLimitMb ?? DUCKDB_DEFAULT_MEMORY_LIMIT_MB,
        )
      }MiB'`,
    );
    await connection.run(
      `SET temp_directory = '${escapeSqlString(paths.tmpDir)}'`,
    );
    for (const statement of buildSchemaStatements()) {
      await connection.run(statement);
    }
  } catch (error) {
    connection.closeSync();
    instance.closeSync();
    throw error;
  }

  // Only after a fully successful open — a crash mid-open leaves no marker,
  // so the next boot retries the wipe instead of trusting a half-built store.
  await writeSchemaMarker(paths);

  return {
    connection,
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

function assertPositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}
