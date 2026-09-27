/**
 * Chart-response shaping for `HostSeriesResult`.
 *
 * `computeSeriesGapCount` / `defaultExpectedSamplesPerBucket` are structurally
 * generic over `{ at, sampleCount?, expectedSampleCount? }`, so they live here
 * natively rather than duplicated per version — this module is their sole
 * home after the v3 cutover.
 */

import type { HostSeriesPoint, HostSeriesResult, MetricsBackendKind } from '../types.ts'
import { bucketFloor } from './buckets.ts'
import {
  computeDerivedHostValues,
  type DerivedHostValues,
  type HostCapacities,
} from './derived-metrics.ts'

/**
 * Expected samples per bucket. Buckets with data pass their observed average
 * collection interval so live (fast-cadence) sessions do not read as
 * over-full against a 60 s assumption; buckets with no points have no
 * observed interval and keep the baseline 60 s default.
 */
export function defaultExpectedSamplesPerBucket(
  resolutionSeconds: number,
  avgIntervalSeconds = 60
): number {
  const interval =
    Number.isFinite(avgIntervalSeconds) && avgIntervalSeconds > 0 ? avgIntervalSeconds : 60
  return Math.max(1, Math.round(resolutionSeconds / interval))
}

/** Share of a sample's spacing tolerated as write-time jitter before an empty bucket counts as missed. */
const COVERAGE_JITTER_FRACTION = 0.1

/**
 * Ingest grace: an empty bucket ending less than this long ago is still
 * pending, not missed — the store needs a moment to make a just-written
 * sample readable (Analytics Engine lags about a minute).
 */
const COVERAGE_TRAILING_INGEST_GRACE_MS = 60_000

/** A bucketed series point as far as coverage is concerned. */
export type CoveragePoint = {
  at: string
  sampleCount?: number
  expectedSampleCount?: number
  /** Latest sample in the bucket (ISO). Absent on older responses: the bucket start stands in. */
  lastSampleAt?: string
  /** Seconds between stored samples in the bucket — see {@link HostSeriesPoint.sampleSpacingSeconds}. */
  sampleSpacingSeconds?: number
}

/**
 * The series' typical spacing between stored samples: sample-weighted mean
 * of the per-bucket spacings, or the 60 s baseline when none reported one.
 */
export function typicalSampleSpacingSeconds(points: readonly CoveragePoint[]): number {
  let weighted = 0
  let weight = 0
  for (const point of points) {
    const spacing = point.sampleSpacingSeconds
    const samples = point.sampleCount ?? 0
    if (spacing === undefined || !Number.isFinite(spacing) || spacing <= 0 || samples <= 0) {
      continue
    }
    weighted += spacing * samples
    weight += samples
  }
  return weight > 0 ? weighted / weight : 60
}

export type SeriesCoverage = {
  /** Starts of the empty buckets where a sample was due and never arrived. */
  gapBucketStarts: number[]
  /** Missing samples: uncovered time over the typical spacing, plus partial-bucket shortfall. */
  gapCount: number
}

/**
 * Coverage on the canonical half-open `[from, to)` grid (bucket starts after
 * floor alignment — an inclusive end would always expect the in-progress
 * bucket, so live charts could never reach 100%).
 *
 * An empty bucket is a gap only when a sample was due inside it: after each
 * bucket with data, the next sample is due one spacing after its latest
 * sample. So a grid finer than the collection cadence (10 s buckets over
 * 60 s samples), or rows a store sampled down (Analytics Engine weighting one
 * row as two samples), leave empty buckets that are not missing data.
 * Leading empties count only when the first sample came more than a spacing
 * after them; empties ending within the store's ingest lag of now are still
 * pending, not missing.
 */
export function computeSeriesCoverage(input: {
  fromMs: number
  toMs: number
  resolutionSeconds: number
  points: readonly CoveragePoint[]
  /** Current time for the ingest grace; defaults to `Date.now()`. */
  nowMs?: number
}): SeriesCoverage {
  const pendingFromMs = (input.nowMs ?? Date.now()) - COVERAGE_TRAILING_INGEST_GRACE_MS
  const bucketMs = input.resolutionSeconds * 1000
  const startMs = bucketFloor(input.fromMs, input.resolutionSeconds)
  const endMs = bucketFloor(input.toMs, input.resolutionSeconds)
  if (endMs <= startMs) return { gapBucketStarts: [], gapCount: 0 }

  const byBucket = new Map<number, CoveragePoint>()
  for (const point of input.points) {
    const atMs = Date.parse(point.at)
    if (!Number.isFinite(atMs) || (point.sampleCount ?? 0) <= 0) continue
    byBucket.set(bucketFloor(atMs, input.resolutionSeconds), point)
  }

  const typicalSpacing = typicalSampleSpacingSeconds(input.points)
  const spacingMsOf = (point: CoveragePoint): number => {
    const spacing = point.sampleSpacingSeconds
    return (
      (spacing !== undefined && Number.isFinite(spacing) && spacing > 0
        ? spacing
        : typicalSpacing) * 1000
    )
  }
  const lastSampleMsOf = (point: CoveragePoint, bucket: number): number => {
    const last = point.lastSampleAt === undefined ? Number.NaN : Date.parse(point.lastSampleAt)
    return Number.isFinite(last) ? last : bucket
  }

  const presentBuckets = [...byBucket.keys()]
    .filter((b) => b >= startMs && b < endMs)
    .sort((a, b) => a - b)
  const firstPresent = presentBuckets[0]
  const leadingDueMs =
    firstPresent === undefined
      ? Number.POSITIVE_INFINITY
      : firstPresent - spacingMsOf(byBucket.get(firstPresent)!)

  const gapBucketStarts: number[] = []
  let shortfall = 0
  let nextDueMs = Number.NEGATIVE_INFINITY
  for (let bucket = startMs; bucket < endMs; bucket += bucketMs) {
    const point = byBucket.get(bucket)
    if (point) {
      const samples = point.sampleCount ?? 0
      const expected =
        point.expectedSampleCount ?? defaultExpectedSamplesPerBucket(input.resolutionSeconds)
      if (samples < expected) shortfall += expected - samples
      const spacingMs = spacingMsOf(point)
      nextDueMs = lastSampleMsOf(point, bucket) + spacingMs * (1 + COVERAGE_JITTER_FRACTION)
      continue
    }
    const bucketEnd = bucket + bucketMs
    if (firstPresent === undefined || bucket < firstPresent) {
      // Before the first sample: missing only if one was due by this bucket's end.
      if (bucketEnd <= leadingDueMs || firstPresent === undefined) gapBucketStarts.push(bucket)
      continue
    }
    if (bucketEnd > pendingFromMs) continue
    if (nextDueMs >= bucketEnd) continue
    gapBucketStarts.push(bucket)
  }

  const gapSeconds = gapBucketStarts.length * input.resolutionSeconds
  return {
    gapBucketStarts,
    gapCount: shortfall + Math.round(gapSeconds / typicalSpacing),
  }
}

/** Missing samples on the canonical grid — see {@link computeSeriesCoverage}. */
export function computeSeriesGapCount(input: {
  fromMs: number
  toMs: number
  resolutionSeconds: number
  points: readonly CoveragePoint[]
  nowMs?: number
}): number {
  return computeSeriesCoverage(input).gapCount
}

export type HostSummaryChartResponse = {
  ok: true
  serverId: string
  from: string
  to: string
  backend: MetricsBackendKind
  available: boolean
  sampleCount: number
  latestAt: string | null
}

export type HostSeriesChartPoint = {
  at: string
  values: Partial<Record<string, number | null>>
  derived: DerivedHostValues
  sampleCount: number
  expectedSampleCount?: number
  /** Seconds between stored samples in this bucket — see `HostSeriesPoint.sampleSpacingSeconds`. */
  sampleSpacingSeconds?: number
  topologyGeneration?: number | null
}

export type HostSeriesChartResponse = {
  ok: true
  serverId: string
  from: string
  to: string
  resolutionSeconds: number | null
  backend: MetricsBackendKind
  available: boolean
  metrics: readonly string[]
  sampleCount: number
  gapCount: number
  /**
   * Starts (ISO) of the empty buckets where a sample was due and never
   * arrived. Other empty buckets (a grid finer than the collection cadence,
   * or rows the store sampled down) are not missing data — the chart draws
   * through them instead of banding them.
   */
  gapBuckets: string[]
  points: HostSeriesChartPoint[]
  /**
   * Point indices where `topologyGeneration` differs from the previous known
   * generation — v5 analogue of v3's `generationBreaks`, renamed since v5
   * tracks topology generations rather than hardware-profile generations.
   * See {@link computeTopologyGenerationBreaks}.
   */
  topologyGenerationBreaks: number[]
  /** Distinct topology generations observed anywhere in the queried range — see `HostSeriesResult.topologyGenerations`. */
  topologyGenerations?: number[]
}

export function finalizeHostSeriesResult(
  from: string,
  to: string,
  result: HostSeriesResult
): HostSeriesResult {
  if (!result.available || result.resolutionSeconds === null) {
    return result
  }
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return result
  }
  const coverage = computeSeriesCoverage({
    fromMs,
    toMs,
    resolutionSeconds: result.resolutionSeconds,
    points: result.points,
  })
  return {
    ...result,
    gapCount: coverage.gapCount,
    gapBuckets: coverage.gapBucketStarts.map((ms) => new Date(ms).toISOString()),
  }
}

/**
 * v5 analogue of v3's `computeGenerationBreaks`, reading `topologyGeneration`
 * instead of `hardwareProfileGeneration` — same semantics: a `null`/`undefined`
 * entry is "unknown" and never itself a break, and the first point
 * establishing a known generation is never a break.
 */
export function computeTopologyGenerationBreaks(
  points: readonly { topologyGeneration?: number | null }[]
): number[] {
  const breaks: number[] = []
  let lastKnown: number | undefined
  for (let i = 0; i < points.length; i++) {
    const generation = points[i].topologyGeneration
    if (generation === null || generation === undefined) continue
    if (lastKnown !== undefined && generation !== lastKnown) {
      breaks.push(i)
    }
    lastKnown = generation
  }
  return breaks
}

export function toHostSeriesChartResponse(input: {
  serverId: string
  from: string
  to: string
  result: HostSeriesResult
  /** Fallback capacities — the latest recorded generation. */
  capacities: HostCapacities
  /**
   * Capacities that were true at each topology generation the range spans.
   * A bucket is divided by the totals its own generation had, so a RAM
   * upgrade or volume resize mid-range no longer restates history against
   * today's hardware. Points whose generation isn't in the map (or that
   * carry no generation at all) fall back to `capacities`.
   */
  capacitiesByGeneration?: ReadonlyMap<number, HostCapacities>
}): HostSeriesChartResponse {
  const result = finalizeHostSeriesResult(input.from, input.to, input.result)
  const capacitiesFor = (generation: number | null | undefined): HostCapacities =>
    (generation != null ? input.capacitiesByGeneration?.get(generation) : undefined) ??
    input.capacities
  const points: HostSeriesChartPoint[] = result.points.map((point: HostSeriesPoint) => ({
    at: point.at,
    values: point.values,
    derived: computeDerivedHostValues(point.values, capacitiesFor(point.topologyGeneration)),
    sampleCount: point.sampleCount ?? 0,
    ...(point.expectedSampleCount !== undefined
      ? { expectedSampleCount: point.expectedSampleCount }
      : {}),
    ...(point.sampleSpacingSeconds !== undefined
      ? { sampleSpacingSeconds: point.sampleSpacingSeconds }
      : {}),
    ...(point.topologyGeneration !== undefined
      ? { topologyGeneration: point.topologyGeneration }
      : {}),
  }))

  return {
    ok: true,
    serverId: input.serverId,
    from: input.from,
    to: input.to,
    resolutionSeconds: result.resolutionSeconds,
    backend: result.kind,
    available: result.available,
    metrics: result.metrics,
    sampleCount: result.sampleCount,
    gapCount: result.gapCount,
    gapBuckets: result.gapBuckets ?? [],
    points,
    topologyGenerationBreaks: computeTopologyGenerationBreaks(points),
    ...(result.topologyGenerations !== undefined
      ? { topologyGenerations: result.topologyGenerations }
      : {}),
  }
}
