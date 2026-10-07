/**
 * The AE SQL API refuses two things DuckDB-backed tests never noticed — both
 * were live on testing (2026-09-27): statements over 10,000 characters
 * (`422 SQL was excessively long`) and MIN/MAX over a String blob column
 * (`422 cannot use the String type as argument 1 in max(`). These tests
 * capture the real statements every query helper sends for the worst-case
 * request and hold them to every rule in `ae-sql-dialect.ts` (length, the
 * functions Cloudflare documents, if() branch types, string aggregates — a
 * hand-kept allowlist here once admitted CONCAT, which AE refuses), and
 * check chunked results merge back into one answer.
 */
import { assert, assertEquals, assertRejects } from '@std/assert'
import { it } from '@std/testing/bdd'
import { MAX_NIC_SLOTS } from '../../../../contracts/topology-types.ts'
import { HOST_METRICS_METRIC_DESCRIPTORS } from '../../metric-descriptors.ts'
import { aeSqlValidationFailure } from '../../testing/fake-analytics-engine.ts'
import { aeSqlDialectFailures, inferAeExpressionType } from './ae-sql-dialect.ts'
import { PER_ENTITY_FIELD_ORDER, SINGLE_ROW_FIELD_ORDER } from './field-map.ts'
import type { PerEntityHostedFamily } from '../../types.ts'
import {
  AE_SQL_MAX_LENGTH,
  CloudflareAnalyticsSqlClient,
  type CloudflareAnalyticsSqlConfig,
  MAX_FLEET_SNAPSHOT_SERVERS,
  mapWithConcurrency,
  mergePointsByAt,
  packItemsBySqlLength,
  packRowsAndColumns,
  queryEntityIdsSeenViaSqlApi,
  queryEntitySeriesViaSqlApi,
  queryFleetHostSnapshotViaSqlApi,
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  queryMetricEventsViaSqlApi,
  queryRecentlyActiveServerIds,
  queryStatusHistoryViaSqlApi,
} from './sql-api.ts'

const HOST_SCOPES = new Set([
  'host.cpu',
  'host.kernel',
  'host.memory',
  'host.storage',
  'host.network',
  'diagnostics',
  'router',
  'storage',
  'dockerUsage',
])

const ENTITY_SCOPE: Record<PerEntityHostedFamily, string> = {
  gpu: 'gpu',
  network: 'network',
  filesystem: 'filesystem',
  block: 'block',
  'hardware.physical': 'hardwareSignal',
  'managed.ingress': 'ingress',
  'managed.database_proxy': 'databaseProxy',
}

/**
 * Most entities one entity-series request can name, per family — the SX
 * (largest) slot budgets from src/features/tiers/ladder.ts (GPU 8,
 * filesystem 18, drive 24), the daemon's NIC cap, and 32 for managed.
 */
const WORST_CASE_ENTITIES: Record<PerEntityHostedFamily, number> = {
  gpu: 8,
  network: MAX_NIC_SLOTS,
  filesystem: 18,
  block: 24,
  'hardware.physical': 24,
  'managed.ingress': 32,
  'managed.database_proxy': 32,
}

const SERVER_ID = '01a0e07a-bbf5-75df-a846-53864fc8cee3'
const TO = '2026-09-27T00:00:00.000Z'
const FROM = '2026-06-30T00:00:00.000Z'

const HOST_METRICS = Object.entries(HOST_METRICS_METRIC_DESCRIPTORS)
  .filter(([, descriptor]) => HOST_SCOPES.has(descriptor.entityScope))
  .map(([name]) => name)

/** Every field v7 stores for the family (the dropped v6 fields are not queryable). */
function fieldsFor(family: PerEntityHostedFamily): string[] {
  const stored: readonly (string | null)[] =
    family === 'managed.ingress' || family === 'managed.database_proxy'
      ? SINGLE_ROW_FIELD_ORDER[family]
      : PER_ENTITY_FIELD_ORDER[family]
  return stored.filter((field): field is string => field !== null && hasDescriptor(family, field))
}

function hasDescriptor(family: PerEntityHostedFamily, field: string): boolean {
  return `${ENTITY_SCOPE[family]}.${field}` in HOST_METRICS_METRIC_DESCRIPTORS
}

function entityIdsFor(family: PerEntityHostedFamily, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    family === 'filesystem'
      ? `/srv/volumes/a-rather-long-mount-point-name-${i}`
      : `${family.replace(/\W/g, '')}-entity-${i}-0123456789abcdef`
  )
}

function serverIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `01a0e07a-bbf5-75df-a846-${String(i).padStart(12, '0')}`
  )
}

type Answer = (sql: string) => Array<Record<string, unknown>>

/** Config whose fetch records every statement and answers with `answer(sql)` rows. */
function capturingConfig(answer: Answer = () => []): {
  config: CloudflareAnalyticsSqlConfig
  statements: string[]
} {
  const statements: string[] = []
  const fetchStub = ((_url: string, init?: RequestInit) => {
    const sql = String(init?.body ?? '')
    statements.push(sql)
    const data = answer(sql)
    return Promise.resolve(
      new Response(JSON.stringify({ data, meta: [], rows: data.length }), { status: 200 })
    )
  }) as unknown as typeof fetch
  return {
    config: {
      accountId: 'account',
      apiToken: 'token',
      maxRangeSeconds: 90 * 24 * 60 * 60,
      fetch: fetchStub,
    },
    statements,
  }
}

function assertAcceptableToAe(statements: readonly string[]): void {
  assert(statements.length > 0, 'no statement was sent')
  for (const sql of statements) {
    assert(sql.length < AE_SQL_MAX_LENGTH, `statement is ${sql.length} chars`)
    assertEquals(aeSqlDialectFailures(sql), [], sql.slice(0, 400))
  }
}

it('host series for every host metric over 90 days stays within AE limits', async () => {
  const { config, statements } = capturingConfig()
  await queryHostSeriesViaSqlApi(config, {
    serverId: SERVER_ID,
    metrics: HOST_METRICS,
    from: FROM,
    to: TO,
  })
  assert(statements.length > 1, 'expected the metric list to be split')
  assertAcceptableToAe(statements)
})

it('fleet snapshot of the maximum fleet and every host metric stays within AE limits', async () => {
  const { config, statements } = capturingConfig()
  await queryFleetHostSnapshotViaSqlApi(config, {
    serverIds: serverIds(MAX_FLEET_SNAPSHOT_SERVERS),
    metrics: HOST_METRICS,
    from: FROM,
    to: TO,
  })
  assertAcceptableToAe(statements)
})

it('host summary, events, status and entity-id queries stay within AE limits', async () => {
  const { config, statements } = capturingConfig()
  const range = { serverId: SERVER_ID, from: FROM, to: TO }
  await queryHostSummaryViaSqlApi(config, range)
  await queryMetricEventsViaSqlApi(config, range)
  await queryStatusHistoryViaSqlApi(config, range)
  for (const family of Object.keys(ENTITY_SCOPE) as PerEntityHostedFamily[]) {
    await queryEntityIdsSeenViaSqlApi(config, { ...range, family })
  }
  assertAcceptableToAe(statements)
})

it('the offline sweep liveness query over the longest window stays within AE rules', async () => {
  // The sweep's `ae-liveness` query runs every minute on Workers; a refusal
  // there marks every server suspect, so it is held to the same dialect.
  const { config, statements } = capturingConfig(() => [
    { server_id: SERVER_ID, latest_at: '2026-09-27 00:00:00' },
  ])
  const active = await queryRecentlyActiveServerIds(config, { sinceSeconds: 7 * 24 * 60 * 60 })
  assertEquals(active.size, 1)
  assertAcceptableToAe(statements)
})

for (const family of Object.keys(ENTITY_SCOPE) as PerEntityHostedFamily[]) {
  it(`entity series (${family}) for every field and the most entities stays within AE limits`, async () => {
    const { config, statements } = capturingConfig()
    const result = await queryEntitySeriesViaSqlApi(config, {
      serverId: SERVER_ID,
      family,
      entityIds: entityIdsFor(family, WORST_CASE_ENTITIES[family]),
      metrics: fieldsFor(family),
      from: FROM,
      to: TO,
    })
    assertEquals(result.entities.length, WORST_CASE_ENTITIES[family])
    assertAcceptableToAe(statements)
  })
}

it('network entity series also sends the host.network embedded-NIC statement and it stays within AE rules', async () => {
  // Every requested NIC is looked up in blob6 of host.network as well as in
  // the paged rows; this is the path whose Integer/Double if() was live on
  // testing after #46.
  const entityIds = entityIdsFor('network', WORST_CASE_ENTITIES.network)
  const { config, statements } = capturingConfig()
  const result = await queryEntitySeriesViaSqlApi(config, {
    serverId: SERVER_ID,
    family: 'network',
    entityIds,
    metrics: fieldsFor('network'),
    from: FROM,
    to: TO,
  })
  assertEquals(result.entities.length, entityIds.length)
  assert(
    statements.some((sql) => sql.includes('_samples')),
    'the embedded-NIC statement was not sent'
  )
  assertAcceptableToAe(statements)
})

it('a chunked host series merges every metric back into one point per bucket', async () => {
  const bucket = Date.parse('2026-09-26T00:00:00.000Z') / 1000
  const { config, statements } = capturingConfig((sql) => {
    const aliases = [...sql.matchAll(/ AS (m\d+)/g)].map((match) => match[1])
    const row: Record<string, unknown> = {
      bucket,
      sample_count: 5,
      avg_interval_seconds: 60,
    }
    for (const alias of aliases) row[alias] = 1
    return [row]
  })
  const result = await queryHostSeriesViaSqlApi(config, {
    serverId: SERVER_ID,
    metrics: HOST_METRICS,
    from: '2026-09-25T00:00:00.000Z',
    to: TO,
  })
  assert(statements.length > 1)
  assertEquals(result.points.length, 1)
  assertEquals(result.sampleCount, 5)
  for (const name of HOST_METRICS) {
    assertEquals(result.points[0].values[name], 1, name)
  }
})

it('a chunked fleet snapshot returns each server once with every metric', async () => {
  const ids = serverIds(MAX_FLEET_SNAPSHOT_SERVERS)
  const { config, statements } = capturingConfig((sql) => {
    const aliases = [...sql.matchAll(/ AS (m\d+)/g)].map((match) => match[1])
    const inList = [...sql.matchAll(/'([0-9a-f-]{36})'/g)].map((match) => match[1])
    return inList.map((serverId) => {
      const row: Record<string, unknown> = {
        server_id: serverId,
        sample_count: 3,
        latest_at: 1_790_000_000,
        topology_gen_min: 2,
        topology_gen_max: 2,
      }
      for (const alias of aliases) row[alias] = 7
      return row
    })
  })
  const result = await queryFleetHostSnapshotViaSqlApi(config, {
    serverIds: ids,
    metrics: HOST_METRICS,
    from: FROM,
    to: TO,
  })
  assert(statements.length > 1)
  assertEquals(result.servers.length, ids.length)
  for (const server of result.servers) {
    assertEquals(server.sampleCount, 3)
    for (const name of HOST_METRICS) assertEquals(server.values[name], 7, name)
  }
})

it('an over-long statement is refused before the request, naming the query', async () => {
  const { config, statements } = capturingConfig()
  const client = new CloudflareAnalyticsSqlClient(config)
  await assertRejects(
    () => client.executeSql(`SELECT ${'x'.repeat(AE_SQL_MAX_LENGTH)}`, 'hostSeries 2/3'),
    Error,
    'AE SQL too long (hostSeries 2/3)'
  )
  assertEquals(statements.length, 0)
})

it('an AE HTTP error names the query in the message', async () => {
  const client = new CloudflareAnalyticsSqlClient({
    accountId: 'account',
    apiToken: 'token',
    fetch: (() =>
      Promise.resolve(
        new Response('Input was invalid', { status: 422 })
      )) as unknown as typeof fetch,
  })
  await assertRejects(
    () => client.executeSql('SELECT 1', 'fleetSnapshot 1/4'),
    Error,
    'AE SQL HTTP 422 (fleetSnapshot 1/4): Input was invalid'
  )
})

it('packItemsBySqlLength keeps order, fills each chunk, and refuses an item that cannot fit', () => {
  const length = (chunk: readonly number[]) => chunk.reduce((sum, n) => sum + n, 0)
  assertEquals(packItemsBySqlLength([3, 3, 3, 5, 1], length, 7), [[3, 3], [3], [5, 1]])
  assertEquals(packItemsBySqlLength([], length, 7), [])
  let refused = false
  try {
    packItemsBySqlLength([2, 9], length, 7)
  } catch (error) {
    refused = error instanceof RangeError
  }
  assert(refused)
})

it('packRowsAndColumns splits only columns when all rows fit, both axes otherwise', () => {
  const length = (rows: readonly number[], cols: readonly number[]) =>
    rows.length * 10 + cols.reduce((sum, n) => sum + n, 0)
  assertEquals(packRowsAndColumns([1, 2], [40, 40, 40], length, 100), [
    { rows: [1, 2], columns: [40, 40] },
    { rows: [1, 2], columns: [40] },
  ])
  const split = packRowsAndColumns(
    Array.from({ length: 12 }, (_, i) => i),
    [20, 20],
    length,
    100
  )
  for (const chunk of split) assert(length(chunk.rows, chunk.columns) <= 100)
  assertEquals(new Set(split.flatMap((chunk) => chunk.rows)).size, 12)
  const columnsPerRowChunk = new Map<string, number[]>()
  for (const chunk of split) {
    const key = chunk.rows.join(',')
    columnsPerRowChunk.set(key, [...(columnsPerRowChunk.get(key) ?? []), ...chunk.columns])
  }
  for (const columns of columnsPerRowChunk.values()) assertEquals(columns, [20, 20])
})

it('mapWithConcurrency keeps order and never exceeds its limit', async () => {
  let inFlight = 0
  let peak = 0
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 1))
    inFlight--
    return n * 10
  })
  assertEquals(results, [10, 20, 30, 40, 50, 60])
  assertEquals(peak, 2)
})

it("mergePointsByAt unions values per bucket, keeps the first chunk's counts, and sorts", () => {
  type Point = { at: string; values: Record<string, number>; sampleCount: number }
  const merged = mergePointsByAt<Point>([
    [
      { at: '2026-09-26T00:05:00.000Z', values: { a: 1 }, sampleCount: 5 },
      { at: '2026-09-26T00:00:00.000Z', values: { a: 2 }, sampleCount: 4 },
    ],
    [{ at: '2026-09-26T00:05:00.000Z', values: { b: 3 }, sampleCount: 9 }],
  ])
  assertEquals(merged, [
    { at: '2026-09-26T00:00:00.000Z', values: { a: 2 }, sampleCount: 4 },
    { at: '2026-09-26T00:05:00.000Z', values: { a: 1, b: 3 }, sampleCount: 5 },
  ])
})

it('the fake AE engine refuses what the real one refuses', () => {
  assertEquals(
    aeSqlValidationFailure('SELECT MAX(blob7) FROM t'),
    'Input was invalid: cannot use the String type as argument 1 in max('
  )
  assertEquals(aeSqlValidationFailure('SELECT MAX(toUInt32(blob7)) FROM t'), null)
  assert(aeSqlValidationFailure('x'.repeat(AE_SQL_MAX_LENGTH + 1))?.includes('excessively long'))
  // Both live on testing after #46: CONCAT, and an Integer/Double if().
  assertEquals(
    aeSqlValidationFailure("SELECT 1 FROM t WHERE blob10 LIKE CONCAT('a,', '%')"),
    'Input was invalid: unknown function call: CONCAT'
  )
  assert(
    aeSqlValidationFailure("SELECT SUM(if(blob1 = 'x', _sample_interval, 0.0)) FROM t")?.includes(
      'must have the same type but instead had Integer and Double'
    )
  )
  assertEquals(
    aeSqlValidationFailure("SELECT SUM(if(blob1 = 'x', _sample_interval * 1.0, 0.0)) FROM t"),
    null
  )
  assertEquals(aeSqlValidationFailure("SELECT 1 FROM t WHERE position(',a,' IN blob10) > 0"), null)
})

it('infers the types AE compares in if() branches', () => {
  assertEquals(inferAeExpressionType('_sample_interval'), 'Integer')
  assertEquals(inferAeExpressionType('_sample_interval * 1.0'), 'Double')
  assertEquals(inferAeExpressionType('0.0'), 'Double')
  assertEquals(inferAeExpressionType('-1e308'), 'Double')
  assertEquals(inferAeExpressionType('double3 * double1 * _sample_interval'), 'Double')
  assertEquals(inferAeExpressionType('toUnixTimestamp(timestamp) * 0'), 'Integer')
  assertEquals(inferAeExpressionType('toUnixTimestamp(timestamp)'), 'Integer')
  assertEquals(inferAeExpressionType("'x'"), 'String')
  assertEquals(inferAeExpressionType('blob7'), 'String')
  assertEquals(inferAeExpressionType('SUM(double1) / SUM(double2)'), 'Double')
  assertEquals(inferAeExpressionType('some_unknown_thing'), 'Unknown')
})

it('function names inside string literals are not function calls', () => {
  assertEquals(aeSqlDialectFailures("SELECT 1 FROM t WHERE blob1 = 'CONCAT(a)'"), [])
})
