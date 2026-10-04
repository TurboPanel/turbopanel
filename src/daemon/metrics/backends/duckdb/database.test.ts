import { assertEquals, assertRejects } from '@std/assert'
import { it } from '@std/testing/bdd'
import { DUCKDB_SCHEMA_MARKER_VERSION, HOST_SAMPLES_TABLE } from './schema.ts'
import {
  openDuckDb,
  readSchemaMarker,
  resolveDuckDbPaths,
  schemaMarkerPath,
  writeSchemaMarker,
} from './database.ts'

it('readSchemaMarker returns null when no marker file exists', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-marker-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    assertEquals(await readSchemaMarker(paths), null)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('writeSchemaMarker + readSchemaMarker round trip the current version', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-marker-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    await writeSchemaMarker(paths)
    assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
    assertEquals(
      (await Deno.readTextFile(schemaMarkerPath(paths))).trim(),
      String(DUCKDB_SCHEMA_MARKER_VERSION)
    )
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('readSchemaMarker treats a corrupt marker file as absent', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-marker-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    await Deno.writeTextFile(schemaMarkerPath(paths), 'not-a-number')
    assertEquals(await readSchemaMarker(paths), null)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb writes the marker and creates the current host columns', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-open-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    const handle = await openDuckDb({ paths })
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
      const columnsReader = await handle.connection.runAndReadAll(
        `SELECT column_name FROM information_schema.columns ` +
          `WHERE table_name = '${HOST_SAMPLES_TABLE}' AND column_name = 'cpu_process_count'`
      )
      assertEquals(columnsReader.getRowObjectsJS().length, 1)
    } finally {
      handle.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

async function fileExistsForTest(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch {
    return false
  }
}

it('openDuckDb refuses to wipe a store whose marker went missing', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-missing-marker-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    const first = await openDuckDb({ paths })
    first.close()
    await Deno.remove(schemaMarkerPath(paths))
    const extraDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(extraDir, { recursive: true })
    await Deno.writeTextFile(`${extraDir}/metrics.parquet`, 'sealed partition')

    await assertRejects(() => openDuckDb({ paths }), Error, 'schema marker')
    assertEquals(await fileExistsForTest(`${extraDir}/metrics.parquet`), true)
    assertEquals(await fileExistsForTest(paths.databasePath), true)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb refuses an orphan parquet tree without a marker', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-orphan-parquet-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    const leftoverDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(leftoverDir, { recursive: true })
    await Deno.writeTextFile(`${leftoverDir}/metrics.parquet`, 'orphaned partition')

    await assertRejects(() => openDuckDb({ paths }), Error, 'schema marker')
    assertEquals(await fileExistsForTest(`${leftoverDir}/metrics.parquet`), true)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb refuses to wipe the store for an empty or corrupt marker', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-corrupt-marker-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    ;(await openDuckDb({ paths })).close()
    const leftoverDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(leftoverDir, { recursive: true })
    await Deno.writeTextFile(`${leftoverDir}/metrics.parquet`, 'partition')
    for (const content of ['', 'not-a-number', '9.5', '-1']) {
      await Deno.writeTextFile(schemaMarkerPath(paths), content)
      await assertRejects(() => openDuckDb({ paths }), Error, 'schema marker')
      assertEquals(await fileExistsForTest(`${leftoverDir}/metrics.parquet`), true)
      assertEquals(await fileExistsForTest(paths.databasePath), true)
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb refuses to wipe the store for a marker newer than this build', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-open-newer-marker-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    ;(await openDuckDb({ paths })).close()
    await Deno.writeTextFile(schemaMarkerPath(paths), String(DUCKDB_SCHEMA_MARKER_VERSION + 1))
    await assertRejects(() => openDuckDb({ paths }), Error, 'schema marker')
    assertEquals(await fileExistsForTest(paths.databasePath), true)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb leaves a current marker file untouched on reopen', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-open-marker-stable-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    ;(await openDuckDb({ paths })).close()
    const before = await Deno.stat(schemaMarkerPath(paths))
    await new Promise((resolve) => setTimeout(resolve, 20))
    ;(await openDuckDb({ paths })).close()
    const after = await Deno.stat(schemaMarkerPath(paths))
    assertEquals(after.mtime?.getTime(), before.mtime?.getTime())
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb discards a stale marker (4) and parquet before creating schema 5', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-stale-marker-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    const first = await openDuckDb({ paths })
    first.close()
    await Deno.writeTextFile(schemaMarkerPath(paths), '4')
    const extraDir = `${paths.parquetRoot}/server-metrics/year=2025`
    await Deno.mkdir(extraDir, { recursive: true })
    await Deno.writeTextFile(`${extraDir}/metrics.parquet`, 'pre-v5 partition')

    const second = await openDuckDb({ paths })
    try {
      assertEquals(await fileExistsForTest(`${extraDir}/metrics.parquet`), false)
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
    } finally {
      second.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb keeps parquet when the current marker (5) is already present', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-duckdb-open-current-marker-',
  })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    const first = await openDuckDb({ paths })
    first.close()
    const extraDir = `${paths.parquetRoot}/server_host_samples/year=2026`
    await Deno.mkdir(extraDir, { recursive: true })
    await Deno.writeTextFile(`${extraDir}/metrics.parquet`, 'current partition')

    const second = await openDuckDb({ paths })
    try {
      assertEquals(await fileExistsForTest(`${extraDir}/metrics.parquet`), true)
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
    } finally {
      second.close()
    }
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})

it('openDuckDb discards a marker-8 store and recreates the current layout', async () => {
  const metricsDir = await Deno.makeTempDir({ prefix: 'tp-duckdb-open-cut-' })
  try {
    const paths = resolveDuckDbPaths(metricsDir)
    ;(await openDuckDb({ paths })).close()
    await Deno.writeTextFile(schemaMarkerPath(paths), '8')
    const stale = `${paths.parquetRoot}/server_host_samples/year=2026`
    await Deno.mkdir(stale, { recursive: true })
    await Deno.writeTextFile(`${stale}/metrics.parquet`, 'stale')

    const handle = await openDuckDb({ paths })
    try {
      assertEquals(await readSchemaMarker(paths), DUCKDB_SCHEMA_MARKER_VERSION)
    } finally {
      handle.close()
    }
    assertEquals(await fileExistsForTest(`${stale}/metrics.parquet`), false)
  } finally {
    await Deno.remove(metricsDir, { recursive: true })
  }
})
