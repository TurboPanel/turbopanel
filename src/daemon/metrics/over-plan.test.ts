import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { evaluateOverPlan, isOverPlan } from './over-plan.ts'

const GIB = 1024 ** 3

it('a server inside its tier is not over plan', () => {
  assertEquals(evaluateOverPlan(1, { memoryTotalBytes: 8 * GIB, logicalCores: 4 }), {
    memory: false,
    cpu: false,
  })
})

it('more RAM than the tier allows is flagged', () => {
  const result = evaluateOverPlan(1, { memoryTotalBytes: 64 * GIB, logicalCores: 4 })
  assertEquals(result, { memory: true, cpu: false })
  assertEquals(isOverPlan(result), true)
})

it('hyperthreads do not count as extra cores, but a CPU count past twice the ceiling does', () => {
  assertEquals(evaluateOverPlan(1, { logicalCores: 8 })?.cpu, false)
  assertEquals(evaluateOverPlan(1, { logicalCores: 9 })?.cpu, true)
})

it('no tier or no sizes means nothing to judge', () => {
  assertEquals(evaluateOverPlan(null, { memoryTotalBytes: 64 * GIB }), null)
  assertEquals(evaluateOverPlan(1, undefined), null)
  assertEquals(isOverPlan(null), false)
})

it('the unbounded custom tier is never over plan', () => {
  assertEquals(
    isOverPlan(evaluateOverPlan(8, { memoryTotalBytes: 4096 * GIB, logicalCores: 1024 })),
    false
  )
})
