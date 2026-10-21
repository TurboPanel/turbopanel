import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import type { ServerHostResources } from '../../features/servers/server-metadata.ts'
import { evaluateOverPlan, isOverPlan } from './over-plan.ts'

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
