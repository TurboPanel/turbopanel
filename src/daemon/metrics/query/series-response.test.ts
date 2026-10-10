import { assertEquals } from '@std/assert'
import type { HostSeriesResult } from '../types.ts'
import {
  computeSeriesCoverage,
  computeSeriesGapCount,
  computeTopologyGenerationBreaks,
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResult,
  toHostSeriesChartResponse,
  typicalSampleSpacingSeconds,
} from './series-response.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function availableResult(overrides: Partial<HostSeriesResult> = {}): HostSeriesResult {
  return {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    metrics: ['host.cpu.busyPercent'],
    points: [],
    resolutionSeconds: 60,
    gapCount: 0,
    sampleCount: 0,
    ...overrides,
  }
}

test('defaultExpectedSamplesPerBucket falls back when the interval is not usable', () => {
  assertEquals(defaultExpectedSamplesPerBucket(60), 1)
  assertEquals(defaultExpectedSamplesPerBucket(60, 10), 6)
  assertEquals(defaultExpectedSamplesPerBucket(60, 0), 1)
  assertEquals(defaultExpectedSamplesPerBucket(60, Number.NaN), 1)
  assertEquals(defaultExpectedSamplesPerBucket(60, -5), 1)
})

test('computeSeriesGapCount returns 0 when the aligned range is empty', () => {
  const fromMs = Date.parse('2026-01-01T00:00:00.000Z')
  assertEquals(
    computeSeriesGapCount({
      fromMs,
      toMs: fromMs,
      resolutionSeconds: 60,
      points: [],
    }),
    0
  )
  assertEquals(
    computeSeriesGapCount({
      fromMs,
      toMs: fromMs - 1,
      resolutionSeconds: 60,
      points: [],
    }),
    0
  )
})

test('computeSeriesGapCount skips unparseable timestamps and counts missing buckets', () => {
  const fromMs = Date.parse('2026-01-01T00:00:00.000Z')
  const toMs = Date.parse('2026-01-01T00:03:00.000Z')
  const gaps = computeSeriesGapCount({
    fromMs,
    toMs,
    resolutionSeconds: 60,
    points: [
      { at: 'not-a-timestamp', sampleCount: 1 },
      {
        at: '2026-01-01T00:00:00.000Z',
        sampleCount: 1,
        expectedSampleCount: 1,
      },
    ],
  })
  assertEquals(gaps, 2)
})

test('finalizeHostSeriesResult leaves unavailable or unparseable ranges unchanged', () => {
  const unavailable = availableResult({
    available: false,
    resolutionSeconds: null,
  })
  assertEquals(
    finalizeHostSeriesResult('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', unavailable),
    unavailable
  )
  const missingResolution = availableResult({ resolutionSeconds: null })
  assertEquals(
    finalizeHostSeriesResult(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z',
      missingResolution
    ),
    missingResolution
  )
  const badRange = availableResult({ gapCount: 7 })
  assertEquals(finalizeHostSeriesResult('not-from', 'not-to', badRange), badRange)
})

test('computeTopologyGenerationBreaks ignores unknown generations', () => {
  assertEquals(
    computeTopologyGenerationBreaks([
      { topologyGeneration: null },
      { topologyGeneration: 1 },
      {},
      { topologyGeneration: 1 },
      { topologyGeneration: 3 },
    ]),
    [4]
  )
})

const NO_CAPACITIES = {
  memoryTotalBytes: null,
  swapTotalBytes: null,
  rootFilesystemTotalBytes: null,
}

test('derived percentages are taken against the size each point carries, so a resize never restates history', () => {
  // A range spanning a RAM upgrade (or a balloon): the first sample had 8 GB,
  // the second 16 GB. The same 6 GB reading is 75% then and 37.5% after. Each
  // point carries the size it was measured against; no topology change is needed.
  const response = toHostSeriesChartResponse({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:02:00.000Z',
    result: availableResult({
      metrics: ['host.memory.usedBytes', 'extended.sizes.memoryTotalBytes'],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: {
            'host.memory.usedBytes': 6_000,
            'extended.sizes.memoryTotalBytes': 8_000,
          },
          topologyGeneration: 1,
        },
        {
          at: '2026-01-01T00:01:00.000Z',
          values: {
            'host.memory.usedBytes': 6_000,
            'extended.sizes.memoryTotalBytes': 16_000,
          },
          topologyGeneration: 1,
        },
      ],
    }),
    capacities: { ...NO_CAPACITIES, memoryTotalBytes: 32_000 },
  })
  assertEquals(response.points[0]!.derived.memoryUsedPercent, 75)
  assertEquals(response.points[1]!.derived.memoryUsedPercent, 37.5)
})

test('swap and root disk percentages use their own per-point sizes too', () => {
  const response = toHostSeriesChartResponse({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:01:00.000Z',
    result: availableResult({
      metrics: [],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: {
            'host.memory.swapUsedBytes': 1_000,
            'extended.sizes.swapTotalBytes': 4_000,
            'host.storage.rootFilesystemAvailableBytes': 30_000,
            'extended.sizes.rootFilesystemTotalBytes': 100_000,
          },
        },
      ],
    }),
    capacities: NO_CAPACITIES,
  })
  assertEquals(response.points[0]!.derived.swapUsedPercent, 25)
  assertEquals(response.points[0]!.derived.rootFilesystemUsedBytes, 70_000)
  assertEquals(response.points[0]!.derived.rootFilesystemUsedPercent, 70)
})

test('a point that carries no size falls back to the latest topology totals', () => {
  const response = toHostSeriesChartResponse({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:01:00.000Z',
    result: availableResult({
      metrics: ['host.memory.usedBytes'],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: { 'host.memory.usedBytes': 4_000 },
          topologyGeneration: 99,
        },
      ],
    }),
    capacities: { ...NO_CAPACITIES, memoryTotalBytes: 16_000 },
  })
  assertEquals(response.points[0]!.derived.memoryUsedPercent, 25)
})

test('a zero or missing per-point size is never a divisor', () => {
  const response = toHostSeriesChartResponse({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:01:00.000Z',
    result: availableResult({
      metrics: [],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: { 'host.memory.usedBytes': 4_000, 'extended.sizes.memoryTotalBytes': 0 },
        },
      ],
    }),
    capacities: NO_CAPACITIES,
  })
  assertEquals(response.points[0]!.derived.memoryUsedPercent, null)
})

test('sizes read only to take a percentage are hidden from the response', () => {
  const response = toHostSeriesChartResponse({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:01:00.000Z',
    result: availableResult({
      metrics: ['host.memory.usedBytes', 'extended.sizes.memoryTotalBytes'],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: {
            'host.memory.usedBytes': 4_000,
            'extended.sizes.memoryTotalBytes': 8_000,
          },
        },
      ],
    }),
    capacities: NO_CAPACITIES,
    hiddenMetrics: new Set(['extended.sizes.memoryTotalBytes']),
  })
  assertEquals(response.points[0]!.derived.memoryUsedPercent, 50)
  assertEquals(response.points[0]!.values, { 'host.memory.usedBytes': 4_000 })
  assertEquals(response.metrics, ['host.memory.usedBytes'])
})

// --- Coverage (2026-09-27 testing: ~30 of 60 minutely buckets "missing") ---

const COVERAGE_T0 = Date.parse('2026-09-27T20:00:00.000Z')
const COVERAGE_NOW = COVERAGE_T0 + 24 * 3600_000 // a historical window: no ingest grace
const at = (ms: number) => new Date(ms).toISOString()

test('AE-sampled rows (one row standing for two samples) leave no gaps at 60 s', () => {
  // Real testing shape: 60 samples in an hour came back as 30 rows, each
  // _sample_interval = 2, in every other 60 s bucket.
  const points = Array.from({ length: 30 }, (_, i) => {
    const bucket = COVERAGE_T0 + i * 120_000
    return {
      at: at(bucket),
      sampleCount: 2,
      expectedSampleCount: 1,
      lastSampleAt: at(bucket + 7_000),
      sampleSpacingSeconds: 120,
    }
  })
  const coverage = computeSeriesCoverage({
    fromMs: COVERAGE_T0,
    toMs: COVERAGE_T0 + 3600_000,
    resolutionSeconds: 60,
    points,
    nowMs: COVERAGE_NOW,
  })
  assertEquals(coverage.gapBucketStarts, [])
  assertEquals(coverage.gapCount, 0)
})

test('a 10 s grid over a 60 s cadence is not 5-in-6 missing', () => {
  const points = Array.from({ length: 10 }, (_, i) => {
    const bucket = COVERAGE_T0 + i * 60_000
    return {
      at: at(bucket),
      sampleCount: 1,
      expectedSampleCount: 1,
      lastSampleAt: at(bucket + 3_000),
      sampleSpacingSeconds: 60,
    }
  })
  const coverage = computeSeriesCoverage({
    fromMs: COVERAGE_T0,
    toMs: COVERAGE_T0 + 600_000,
    resolutionSeconds: 10,
    points,
    nowMs: COVERAGE_NOW,
  })
  assertEquals(coverage.gapCount, 0)
})

test('a genuinely missed sample is still a gap, counted in samples', () => {
  // 60 s cadence, minute 2 never arrived.
  const minutes = [0, 1, 3, 4]
  const points = minutes.map((m) => {
    const bucket = COVERAGE_T0 + m * 60_000
    return {
      at: at(bucket),
      sampleCount: 1,
      expectedSampleCount: 1,
      lastSampleAt: at(bucket + 20_000),
      sampleSpacingSeconds: 60,
    }
  })
  const at60 = computeSeriesCoverage({
    fromMs: COVERAGE_T0,
    toMs: COVERAGE_T0 + 300_000,
    resolutionSeconds: 60,
    points,
    nowMs: COVERAGE_NOW,
  })
  assertEquals(at60.gapBucketStarts, [COVERAGE_T0 + 120_000])
  assertEquals(at60.gapCount, 1)

  // Same data on a 10 s grid: the missed sample's bucket is the gap.
  const at10 = computeSeriesCoverage({
    fromMs: COVERAGE_T0,
    toMs: COVERAGE_T0 + 300_000,
    resolutionSeconds: 10,
    points,
    nowMs: COVERAGE_NOW,
  })
  assertEquals(at10.gapBucketStarts.includes(COVERAGE_T0 + 140_000), true)
  assertEquals(at10.gapCount, 1)
})

test('leading empties count only when a sample was due; recent empties are pending', () => {
  const points = [
    {
      at: at(COVERAGE_T0 + 120_000),
      sampleCount: 1,
      lastSampleAt: at(COVERAGE_T0 + 125_000),
      sampleSpacingSeconds: 60,
    },
  ]
  // Minute 0 had a sample due (first one arrived two spacings later); minute 1 did not need one.
  const coverage = computeSeriesCoverage({
    fromMs: COVERAGE_T0,
    toMs: COVERAGE_T0 + 240_000,
    resolutionSeconds: 60,
    points,
    nowMs: COVERAGE_T0 + 240_000,
  })
  // Minute 3 ends at "now": pending ingest, not missing.
  assertEquals(coverage.gapBucketStarts, [COVERAGE_T0])
})

test('with no data at all every bucket is a gap', () => {
  const coverage = computeSeriesCoverage({
    fromMs: COVERAGE_T0,
    toMs: COVERAGE_T0 + 180_000,
    resolutionSeconds: 60,
    points: [],
    nowMs: COVERAGE_NOW,
  })
  assertEquals(coverage.gapBucketStarts.length, 3)
  assertEquals(coverage.gapCount, 3)
})

test('typical spacing is the sample-weighted mean, defaulting to 60 s', () => {
  assertEquals(typicalSampleSpacingSeconds([]), 60)
  assertEquals(
    typicalSampleSpacingSeconds([
      { at: at(COVERAGE_T0), sampleCount: 1, sampleSpacingSeconds: 60 },
      { at: at(COVERAGE_T0), sampleCount: 3, sampleSpacingSeconds: 20 },
      { at: at(COVERAGE_T0), sampleCount: 0, sampleSpacingSeconds: 999 },
    ]),
    30
  )
})

test('finalizeHostSeriesResult attaches the gap buckets', () => {
  const result = finalizeHostSeriesResult(at(COVERAGE_T0), at(COVERAGE_T0 + 180_000), {
    kind: 'analytics-engine',
    available: true,
    serverId: '01a0e07a-bbf5-75df-a846-53864fc8cee3',
    metrics: [],
    points: [
      { at: at(COVERAGE_T0), values: {}, sampleCount: 1, sampleSpacingSeconds: 60 },
      { at: at(COVERAGE_T0 + 120_000), values: {}, sampleCount: 1, sampleSpacingSeconds: 60 },
    ],
    resolutionSeconds: 60,
    gapCount: 0,
    sampleCount: 2,
  })
  assertEquals(result.gapBuckets, [at(COVERAGE_T0 + 60_000)])
  assertEquals(result.gapCount, 1)
})
