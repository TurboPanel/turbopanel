/**
 * Tier model for metrics v8: what each plan stores, how many Analytics Engine
 * rows a host writes per sample, and what that costs per host-month.
 *
 *   deno task metrics:tiers
 *
 * Row counts come from the canonical layout fixture
 * (`src/daemon/metrics/testing/v8-layout.fixture.json`, generated from the
 * owner-sealed explorer by `scripts/metrics-v8-layout/generate.mjs`), never
 * from re-derived packing, so the model cannot drift from the write path the
 * fixture test pins. Plan limits come from the real ladder through
 * `metricsCapabilityPlanFromTierEntitlements`, so `isEntryTier` and every
 * carve-out are whatever production applies; any difference from the
 * fixture's limits is printed as DRIFT and fails the run.
 *
 * Model facts (v8): every family writes on every 60 s sample; a live lease
 * keeps the 60 s baseline running and stores only that (10 s samples feed the
 * live overlay), so a lease adds no durable rows; Docker metrics are on every
 * plan; drive slots are multiples of 3; self-hosted ingest is not priced.
 */
import {
  METRICS_BASELINE_INTERVAL_SECONDS,
  metricsCapabilityPlanFromTierEntitlements,
} from '../src/contracts/capability-plan.ts'
import { LADDER, ladderEntitlements } from '../src/features/tiers/ladder.ts'
import fixtureJson from '../src/daemon/metrics/testing/v8-layout.fixture.json' with { type: 'json' }

type PlanLimits = {
  nicSlots: number
  driveSlots: number
  gpuSlots: number
  filesystemSlots: number
  sensorSignals: number
  docker: boolean
}
type FixtureCase = {
  id: string
  plan: string
  rowCount: number
}
const fixture = fixtureJson as unknown as {
  planLimits: Record<string, PlanLimits>
  cases: FixtureCase[]
}

export const SAMPLES_PER_MONTH = (30 * 24 * 3600) / METRICS_BASELINE_INTERVAL_SECONDS
const INCLUDED = 10_000_000
const PRICE_PER_M = 0.25
/** One invocation may write at most this many points. */
const AE_POINTS_PER_INVOCATION = 250
const MAX_EVENTS_PER_SAMPLE = 128
/** Live 10 s cadence relative to the 60 s baseline: what v6 stored while a lease was open. */
const V6_LIVE_MULTIPLIER = 6

/** The machine shapes priced per tier, as fixture case suffixes. */
export const SHAPES = [
  { label: 'VPS, native sites', suffix: 'vps/preset/plain' },
  { label: 'VPS + Docker', suffix: 'vps/preset/docker' },
  { label: 'VPS + Docker + managed DB', suffix: 'vps/preset/docker+db' },
  { label: 'Physical, 1 drive', suffix: 'phys/single/docker' },
  { label: 'Physical, 2 drives + Docker', suffix: 'phys/preset/docker' },
  { label: 'Physical, fully loaded', suffix: 'phys/max/docker+db' },
] as const

export function rowsFor(plan: string, suffix: string): number {
  const found = fixture.cases.find((c) => c.id === `${plan}/${suffix}`)
  if (!found) throw new Error(`no fixture case ${plan}/${suffix}`)
  return found.rowCount
}

export function pointsPerMonth(rowsPerSample: number): number {
  return rowsPerSample * SAMPLES_PER_MONTH
}

export function listPriceCost(points: number): number {
  return (points / 1_000_000) * PRICE_PER_M
}

/** Differences between the production plan for a ladder rung and the fixture's limits. */
export function planDrift(label: string): string[] {
  const entitlements = ladderEntitlements(label)
  const limits = fixture.planLimits[label]
  if (!entitlements || !limits) return [`${label}: missing from ladder or fixture`]
  const plan = metricsCapabilityPlanFromTierEntitlements(entitlements, 'physical', 'hosted')
  const actual: Record<string, number | boolean> = {
    nicSlots: plan.normalNicSlots,
    driveSlots: plan.detailedBlockDeviceSlots,
    gpuSlots: plan.gpuSlots,
    filesystemSlots: plan.extraFilesystemSlots,
    sensorSignals: plan.physicalHardwareSignalSlots,
    docker: plan.managedDockerEnabled,
  }
  return Object.entries(actual)
    .filter(([key, value]) => limits[key as keyof PlanLimits] !== value)
    .map(
      ([key, value]) =>
        `${label}.${key}: ladder gives ${value}, fixture expects ${limits[key as keyof PlanLimits]}`
    )
}

function pad(v: string, w: number) {
  return v.length >= w ? v : v + ' '.repeat(w - v.length)
}
function padLeft(v: string, w: number) {
  return v.length >= w ? v : ' '.repeat(w - v.length) + v
}

function printLimits(): string[] {
  console.log('=== 1. Plan limits (ladder through the capability plan) ===\n')
  console.log(
    pad('Plan', 6) +
      padLeft('NIC', 5) +
      padLeft('drive', 7) +
      padLeft('GPU', 5) +
      padLeft('fs', 5) +
      padLeft('sensors', 9) +
      padLeft('docker', 8)
  )
  console.log('-'.repeat(45))
  const drift: string[] = []
  for (const rung of LADDER) {
    const limits = fixture.planLimits[rung.label]
    console.log(
      pad(rung.label, 6) +
        padLeft(String(limits.nicSlots), 5) +
        padLeft(String(limits.driveSlots), 7) +
        padLeft(String(limits.gpuSlots), 5) +
        padLeft(String(limits.filesystemSlots), 5) +
        padLeft(String(limits.sensorSignals), 9) +
        padLeft(limits.docker ? 'yes' : 'no', 8)
    )
    drift.push(...planDrift(rung.label))
  }
  for (const line of drift) console.log(`  DRIFT ${line}`)
  return drift
}

function printRows(): void {
  console.log('\n=== 2. Rows per sample and cost per host-month ===\n')
  console.log(
    `${SAMPLES_PER_MONTH.toLocaleString('en-US')} samples per host-month; ` +
      `list price $${PRICE_PER_M}/M points beyond ${INCLUDED.toLocaleString(
        'en-US'
      )} free per account.\n`
  )
  for (const rung of LADDER) {
    const price =
      rung.listPriceCents === null ? 'custom' : `$${(rung.listPriceCents / 100).toFixed(2)}/mo`
    console.log(`${rung.label} (${price})`)
    for (const shape of SHAPES) {
      const rows = rowsFor(rung.label, shape.suffix)
      const points = pointsPerMonth(rows)
      const cost = listPriceCost(points)
      const share =
        rung.listPriceCents === null
          ? ''
          : ` ${((cost / (rung.listPriceCents / 100)) * 100).toFixed(2)}% of price`
      console.log(
        '  ' +
          pad(shape.label, 30) +
          padLeft(String(rows), 3) +
          ' rows' +
          padLeft(points.toLocaleString('en-US'), 12) +
          ' pts/mo' +
          padLeft(`$${cost.toFixed(3)}`, 9) +
          share
      )
    }
  }
}

function printInvocationLimit(): void {
  console.log('\n=== 3. Worst sample vs the 250-point invocation limit ===\n')
  for (const rung of LADDER) {
    const rows = rowsFor(rung.label, 'phys/max/docker+db')
    const worst = rows + MAX_EVENTS_PER_SAMPLE
    const verdict = worst <= AE_POINTS_PER_INVOCATION ? 'ok' : 'OVER'
    console.log(
      `  ${pad(rung.label, 4)} ${rows} rows + ${MAX_EVENTS_PER_SAMPLE} events = ${worst}  ${verdict}`
    )
  }
}

function printLiveLeases(): void {
  console.log('\n=== 4. Live leases ===\n')
  console.log('  v8 keeps the 60 s baseline running during a lease and stores only that;')
  console.log('  the 10 s samples go to the live overlay buffer. A lease adds +0 durable rows.')
  const rows = rowsFor('S1', 'vps/preset/docker')
  const extra = rows * (V6_LIVE_MULTIPLIER - 1) * 60 * 240
  console.log(
    `  (v6 stored every 10 s sample: an S1 web VM watched 8 h/day wrote ${extra.toLocaleString(
      'en-US'
    )} extra points/month.)`
  )
}

if (import.meta.main) {
  console.log('METRICS TIER MODEL (v8) — rows from the canonical layout fixture\n')
  const drift = printLimits()
  printRows()
  printInvocationLimit()
  printLiveLeases()
  if (drift.length > 0) {
    console.error(`\n${drift.length} plan limit(s) drift from the fixture.`)
    Deno.exitCode = 1
  }
}
