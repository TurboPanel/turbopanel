import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import type { ServerHostResources } from '../../features/servers/server-metadata.ts'
import { evaluateOverPlan, isOverPlan } from './over-plan.ts'

const GIB = 1024 ** 3

/** One entry per socket, the way the daemon reports them. */
function sockets(...coreCounts: number[]): ServerHostResources {
  return { cpus: coreCounts.map((total) => ({ cores: { total } })) as ServerHostResources['cpus'] }
}

it('a server inside its tier is not over plan', () => {
  assertEquals(evaluateOverPlan(1, sockets(4), 8 * GIB), { memory: false, cpu: false })
})

it('more RAM than the tier allows is flagged', () => {
  const result = evaluateOverPlan(1, sockets(4), 64 * GIB)
  assertEquals(result, { memory: true, cpu: false })
  assertEquals(isOverPlan(result), true)
})

it('more physical cores than the tier allows is flagged, counted across sockets', () => {
  assertEquals(evaluateOverPlan(1, sockets(4), 8 * GIB)?.cpu, false)
  assertEquals(evaluateOverPlan(1, sockets(3, 3), 8 * GIB)?.cpu, true)
})

it('RAM falls back to the host report when the sample carries no size', () => {
  const resources = { ...sockets(2), memory: { totalBytes: 64 * GIB } }
  assertEquals(evaluateOverPlan(1, resources, null)?.memory, true)
})

it('no tier means nothing to judge, and unknown hardware is never over plan', () => {
  assertEquals(evaluateOverPlan(null, sockets(64), 64 * GIB), null)
  assertEquals(isOverPlan(evaluateOverPlan(1, undefined, undefined)), false)
})

it('the unbounded custom tier is never over plan', () => {
  assertEquals(isOverPlan(evaluateOverPlan(8, sockets(512), 4096 * GIB)), false)
})
