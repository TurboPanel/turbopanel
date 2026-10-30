import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import type { ServerHostResources } from '../../features/servers/server-metadata.ts'
import { evaluateOverPlan, evaluateOverPlanFromPeak, isOverPlan } from './over-plan.ts'
import { peakReadingFromReport, readOverPlanStamp } from './over-plan-flag.ts'

const GIB = 1024 ** 3

/** One entry per socket, the way the daemon reports them. */
function sockets(...coreCounts: number[]): ServerHostResources {
  return { cpus: coreCounts.map((total) => ({ cores: { total } })) as ServerHostResources['cpus'] }
}

/** The host report with its RAM in GiB. */
function withRam(resources: ServerHostResources, gib: number): ServerHostResources {
  return { ...resources, memory: { totalBytes: gib * GIB } } as ServerHostResources
}

it('a server inside its tier is not over plan', () => {
  assertEquals(evaluateOverPlan(1, withRam(sockets(4), 8)), { memory: false, cpu: false })
})

it('more RAM than the tier allows is flagged', () => {
  const result = evaluateOverPlan(1, withRam(sockets(4), 64))
  assertEquals(result, { memory: true, cpu: false })
  assertEquals(isOverPlan(result), true)
})

it('more physical cores than the tier allows is flagged, counted across sockets', () => {
  assertEquals(evaluateOverPlan(1, withRam(sockets(4), 8))?.cpu, false)
  assertEquals(evaluateOverPlan(1, withRam(sockets(3, 3), 8))?.cpu, true)
})

it('a host report without RAM never flags memory', () => {
  assertEquals(evaluateOverPlan(1, sockets(2))?.memory, false)
})

it('no tier means nothing to judge, and unknown hardware is never over plan', () => {
  assertEquals(evaluateOverPlan(null, withRam(sockets(64), 64)), null)
  assertEquals(isOverPlan(evaluateOverPlan(1, undefined)), false)
})

it('the unbounded custom tier is never over plan', () => {
  assertEquals(isOverPlan(evaluateOverPlan(8, withRam(sockets(512), 4096))), false)
})

it('the grace-window peak decides: a high reading flags, no reading never does', () => {
  assertEquals(evaluateOverPlanFromPeak(1, { memoryBytes: 64 * GIB, cores: 4 }), {
    memory: true,
    cpu: false,
  })
  assertEquals(evaluateOverPlanFromPeak(1, { memoryBytes: 8 * GIB, cores: 6 })?.cpu, true)
  assertEquals(isOverPlan(evaluateOverPlanFromPeak(1, { memoryBytes: 8 * GIB, cores: 4 })), false)
  assertEquals(isOverPlan(evaluateOverPlanFromPeak(1, null)), false)
  assertEquals(evaluateOverPlanFromPeak(null, { memoryBytes: 64 * GIB, cores: 64 }), null)
})

it('the peak reading takes the higher RAM of sample and host report, and physical cores only from the host report', () => {
  const metadata = { resources: withRam(sockets(3, 3), 8) }
  assertEquals(peakReadingFromReport(metadata, 64 * GIB), { memoryBytes: 64 * GIB, cores: 6 })
  assertEquals(peakReadingFromReport(metadata, 4 * GIB), { memoryBytes: 8 * GIB, cores: 6 })
})

it('an older daemon with no sample sizes falls back to the host report, and no report reads as nothing', () => {
  assertEquals(peakReadingFromReport({ resources: withRam(sockets(4), 16) }, undefined), {
    memoryBytes: 16 * GIB,
    cores: 4,
  })
  assertEquals(peakReadingFromReport(null, null), { memoryBytes: 0, cores: 0 })
  assertEquals(peakReadingFromReport({}, Number.NaN), { memoryBytes: 0, cores: 0 })
})

it('an over-plan stamp from before `since` existed reads its refresh time as the start', () => {
  const at = '2026-10-20T00:00:00.000Z'
  assertEquals(readOverPlanStamp({ overPlan: { at, memory: true } }), {
    at,
    since: at,
    memory: true,
    cpu: false,
  })
  assertEquals(readOverPlanStamp({ overPlan: { memory: true } }), null)
  assertEquals(readOverPlanStamp(null), null)
})
