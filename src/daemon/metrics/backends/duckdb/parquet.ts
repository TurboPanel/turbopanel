/**
 * Daily Parquet archive for the DuckDB server-metrics store.
 *
 * Completed UTC days are sealed out of the hot `server_metric_samples` table
 * into an immutable partition tree:
 *
 *   <parquetRoot>/server-metrics/year=YYYY/month=MM/day=DD/metrics.parquet
 *
 * Sealing is crash-safe: export to a tmp file, validate the row count by
 * re-reading the produced Parquet, atomically rename into the partition tree,
 * and only then delete the hot rows. A crash at any point leaves either the
 * hot rows intact (tmp leftovers are swept on the next tick) or a complete
 * sealed partition — never a half-archived day. Resealing a day that already
 * has a partition (late-arriving samples) merges the existing sealed rows
 * with the new hot rows, so archiving stays idempotent and one-file-per-day.
 */

import type { DuckDbConnectionLike } from "./database.ts";
import { escapeSqlString } from "./database.ts";
import { HOST_METRICS_TABLE, STATUS_EVENTS_TABLE } from "./schema.ts";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Partition subtree under the parquet root holding host-sample days. */
export const PARQUET_SERVER_METRICS_SUBDIR = "server-metrics";

/** File name of each sealed daily partition. */
export const PARQUET_PARTITION_FILE = "metrics.parquet";

/** Floor an epoch-ms instant to its UTC day start. */
export function utcDayStartMs(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

function assertSafeEpochMs(label: string, ms: number): number {
  if (!Number.isSafeInteger(ms)) {
    throw new TypeError(`${label} must be a safe integer epoch-ms value`);
  }
  return ms;
}

/** `TIMESTAMP '...'` literal (UTC) for a validated epoch-ms instant. */
export function timestampLiteralFromMs(ms: number): string {
  assertSafeEpochMs("timestamp", ms);
  const iso = new Date(ms).toISOString();
  return `TIMESTAMP '${iso.replace("T", " ").replace("Z", "")}'`;
}

function dayParts(dayStartMs: number): { year: string; month: string; day: string } {
  const date = new Date(dayStartMs);
  return {
    year: String(date.getUTCFullYear()).padStart(4, "0"),
    month: String(date.getUTCMonth() + 1).padStart(2, "0"),
    day: String(date.getUTCDate()).padStart(2, "0"),
  };
}

/** Directory of the sealed partition for a UTC day start. */
export function partitionDirForDay(parquetRoot: string, dayStartMs: number): string {
  const { year, month, day } = dayParts(utcDayStartMs(dayStartMs));
  return `${parquetRoot}/${PARQUET_SERVER_METRICS_SUBDIR}/year=${year}/month=${month}/day=${day}`;
}

/** Sealed partition file path for a UTC day start. */
export function partitionFileForDay(parquetRoot: string, dayStartMs: number): string {
  return `${partitionDirForDay(parquetRoot, dayStartMs)}/${PARQUET_PARTITION_FILE}`;
}

export type SealDayInput = {
  dayStartMs: number;
  dayEndMs: number;
  parquetRoot: string;
  tmpDir: string;
};

export type SealDayResult = {
  /** Rows sealed out of the hot table (0 = nothing to archive, no file written). */
  rowCount: number;
  /** Final partition file path, or null when the day held no rows. */
  parquetPath: string | null;
};

async function countRows(
  connection: DuckDbConnectionLike,
  sql: string,
): Promise<number> {
  const reader = await connection.runAndReadAll(sql);
  const row = reader.getRowObjectsJS()[0];
  return Number(row?.n ?? 0);
}

/**
 * Seal one UTC day of hot rows into an immutable Parquet partition.
 *
 * Hot rows are deleted only after the exported file has been validated and
 * atomically renamed into place; a validation mismatch removes the tmp file
 * and throws, leaving the hot table untouched.
 *
 * When the day already has a sealed partition (a late sample arrived after
 * the first seal), the replacement file is rebuilt from the union of the
 * existing partition and the day's hot rows — resealing is idempotent and
 * never drops previously archived rows.
 */
export async function sealDayToParquet(
  connection: DuckDbConnectionLike,
  input: SealDayInput,
): Promise<SealDayResult> {
  assertSafeEpochMs("dayStartMs", input.dayStartMs);
  assertSafeEpochMs("dayEndMs", input.dayEndMs);
  if (input.dayEndMs <= input.dayStartMs) {
    throw new TypeError("dayEndMs must be > dayStartMs");
  }
  const windowPredicate = `sampled_at >= ${timestampLiteralFromMs(input.dayStartMs)}` +
    ` AND sampled_at < ${timestampLiteralFromMs(input.dayEndMs)}`;

  const rowCount = await countRows(
    connection,
    `SELECT count(*) AS n FROM ${HOST_METRICS_TABLE} WHERE ${windowPredicate}`,
  );
  if (rowCount === 0) {
    return { rowCount: 0, parquetPath: null };
  }

  const finalPath = partitionFileForDay(input.parquetRoot, input.dayStartMs);
  let hasExistingPartition = false;
  try {
    hasExistingPartition = (await Deno.stat(finalPath)).isFile;
  } catch {
    // No sealed partition yet — first seal for this day.
  }
  const existingCount = hasExistingPartition
    ? await countRows(
      connection,
      `SELECT count(*) AS n FROM read_parquet('${escapeSqlString(finalPath)}')`,
    )
    : 0;

  const { year, month, day } = dayParts(utcDayStartMs(input.dayStartMs));
  const tmpPath =
    `${input.tmpDir}/day-${year}${month}${day}-${crypto.randomUUID()}.parquet`;
  const hotSelect =
    `SELECT * FROM ${HOST_METRICS_TABLE} WHERE ${windowPredicate}`;
  const exportSelect = hasExistingPartition
    ? `SELECT * FROM (${hotSelect} UNION ALL BY NAME ` +
      `SELECT * FROM read_parquet('${escapeSqlString(finalPath)}'))` +
      ` ORDER BY server_id, sampled_at`
    : `${hotSelect} ORDER BY server_id, sampled_at`;
  await connection.run(
    `COPY (${exportSelect}) TO '${escapeSqlString(tmpPath)}' (FORMAT PARQUET)`,
  );

  const expectedCount = rowCount + existingCount;
  const exportedCount = await countRows(
    connection,
    `SELECT count(*) AS n FROM read_parquet('${escapeSqlString(tmpPath)}')`,
  );
  if (exportedCount !== expectedCount) {
    await Deno.remove(tmpPath).catch(() => {});
    throw new Error(
      `parquet seal validation failed: exported ${exportedCount} rows, expected ${expectedCount}`,
    );
  }

  await Deno.mkdir(partitionDirForDay(input.parquetRoot, input.dayStartMs), {
    recursive: true,
  });
  // Atomic replace — overwrites the previous partition file when resealing.
  await Deno.rename(tmpPath, finalPath);

  await connection.run(
    `DELETE FROM ${HOST_METRICS_TABLE} WHERE ${windowPredicate}`,
  );
  return { rowCount, parquetPath: finalPath };
}

/**
 * Sweep leftover in-flight exports (`<tmpDir>/*.parquet`) from a crashed or
 * interrupted seal — an interrupted export must never be mistaken for a
 * sealed partition, and its hot rows are still in the hot table.
 */
export async function cleanupTmpParquetFiles(tmpDir: string): Promise<void> {
  let entries: AsyncIterable<Deno.DirEntry>;
  try {
    entries = Deno.readDir(tmpDir);
  } catch {
    return;
  }
  try {
    for await (const entry of entries) {
      if (entry.isFile && entry.name.endsWith(".parquet")) {
        await Deno.remove(`${tmpDir}/${entry.name}`).catch(() => {});
      }
    }
  } catch {
    // Missing/racing directory — nothing to clean.
  }
}

type PartitionDay = { dayStartMs: number; dir: string; file: string };

async function readDirSafe(path: string): Promise<Deno.DirEntry[]> {
  const out: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(path)) out.push(entry);
  } catch {
    return [];
  }
  return out;
}

function parsePartitionComponent(name: string, prefix: string): number | null {
  if (!name.startsWith(prefix)) return null;
  const value = Number(name.slice(prefix.length));
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Subdirectories of `dir` named `<prefix><non-negative integer>`. */
async function listNumericSubdirs(
  dir: string,
  prefix: string,
): Promise<{ value: number; path: string }[]> {
  const out: { value: number; path: string }[] = [];
  for (const entry of await readDirSafe(dir)) {
    if (!entry.isDirectory) continue;
    const value = parsePartitionComponent(entry.name, prefix);
    if (value === null) continue;
    out.push({ value, path: `${dir}/${entry.name}` });
  }
  return out;
}

/** The day's partition, or null when its parquet file is missing (unsealed). */
async function sealedPartitionDay(
  year: number,
  month: number,
  day: number,
  dir: string,
): Promise<PartitionDay | null> {
  const file = `${dir}/${PARQUET_PARTITION_FILE}`;
  try {
    const stat = await Deno.stat(file);
    if (!stat.isFile) return null;
  } catch {
    return null;
  }
  return { dayStartMs: Date.UTC(year, month - 1, day), dir, file };
}

/** Enumerate all sealed day partitions under the parquet root, sorted by day. */
export async function listPartitionDays(
  parquetRoot: string,
): Promise<PartitionDay[]> {
  const base = `${parquetRoot}/${PARQUET_SERVER_METRICS_SUBDIR}`;
  const days: PartitionDay[] = [];
  for (const year of await listNumericSubdirs(base, "year=")) {
    for (const month of await listNumericSubdirs(year.path, "month=")) {
      for (const day of await listNumericSubdirs(month.path, "day=")) {
        const partition = await sealedPartitionDay(
          year.value,
          month.value,
          day.value,
          day.path,
        );
        if (partition) days.push(partition);
      }
    }
  }
  days.sort((a, b) => a.dayStartMs - b.dayStartMs);
  return days;
}

/**
 * Sealed partition files whose UTC day overlaps the half-open `[fromMs, toMs)`
 * range, sorted by day — the read path unions these with the hot table via
 * `read_parquet([...], union_by_name := true)`.
 */
export async function listPartitionFilesInRange(
  parquetRoot: string,
  fromMs: number,
  toMs: number,
): Promise<string[]> {
  const days = await listPartitionDays(parquetRoot);
  return days
    .filter((day) =>
      day.dayStartMs < toMs && day.dayStartMs + MS_PER_DAY > fromMs
    )
    .map((day) => day.file);
}

export type PruneExpiredPartitionsInput = {
  retentionDays: number;
  parquetRoot: string;
  nowMs?: number;
};

/**
 * Delete sealed partitions and hot rows older than the retention cutoff.
 *
 * The hot-table delete is defense-in-depth: normally the daily archive job
 * seals every completed day, but if it missed one, retention still holds.
 */
export async function pruneExpiredPartitions(
  connection: DuckDbConnectionLike,
  input: PruneExpiredPartitionsInput,
): Promise<void> {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays <= 0) {
    throw new TypeError("retentionDays must be a positive integer");
  }
  const nowMs = input.nowMs ?? Date.now();
  const cutoffMs = utcDayStartMs(nowMs) - input.retentionDays * MS_PER_DAY;

  for (const day of await listPartitionDays(input.parquetRoot)) {
    if (day.dayStartMs + MS_PER_DAY <= cutoffMs) {
      await Deno.remove(day.dir, { recursive: true }).catch(() => {});
    }
  }

  const cutoffLiteral = timestampLiteralFromMs(cutoffMs);
  await connection.run(
    `DELETE FROM ${HOST_METRICS_TABLE} WHERE sampled_at < ${cutoffLiteral}`,
  );
  await connection.run(
    `DELETE FROM ${STATUS_EVENTS_TABLE} WHERE "at" < ${cutoffLiteral}`,
  );
}
