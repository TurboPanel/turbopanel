import { assertEquals, assertRejects } from '@std/assert'
import { firstSequential, forEachSequential, mapSequential } from './sequential.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}: Sonar typescript:S2187 only
 * recognises `test()` / `it()` and reports Deno suites as empty.
 */
const test = Deno.test.bind(Deno)

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('forEachSequential runs steps one at a time, in order', async () => {
  const log: string[] = []
  await forEachSequential(['a', 'b', 'c'], async (item) => {
    log.push(`start ${item}`)
    await tick(item === 'a' ? 15 : 1)
    log.push(`end ${item}`)
  })
  assertEquals(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
})

test('forEachSequential stops at the first rejection and starts nothing after it', async () => {
  const started: number[] = []
  await assertRejects(
    () =>
      forEachSequential([1, 2, 3], (n) => {
        started.push(n)
        if (n === 2) return Promise.reject(new Error('boom'))
      }),
    Error,
    'boom'
  )
  assertEquals(started, [1, 2])
})

test('mapSequential keeps input order and passes the index', async () => {
  const out = await mapSequential(['x', 'y'], async (item, index) => {
    await tick(index === 0 ? 10 : 0)
    return `${index}:${item}`
  })
  assertEquals(out, ['0:x', '1:y'])
  assertEquals(await mapSequential([], () => 1), [])
})

test('firstSequential returns the first defined result and stops trying', async () => {
  const tried: number[] = []
  const found = await firstSequential([1, 2, 3, 4], async (n) => {
    tried.push(n)
    return n === 2 ? 'two' : undefined
  })
  assertEquals(found, 'two')
  assertEquals(tried, [1, 2])
  assertEquals(await firstSequential([1, 2], () => undefined), undefined)
  assertEquals(await firstSequential([], () => 'never'), undefined)
})

test('firstSequential treats null like undefined and keeps falsy results such as false, 0 and empty string', async () => {
  const tried: number[] = []
  const results = [undefined, null, 'three']
  const skipped = await firstSequential([0, 1, 2], (i) => {
    tried.push(i)
    return results[i]
  })
  assertEquals(skipped, 'three')
  assertEquals(tried, [0, 1, 2])

  for (const falsy of [false, 0, ''] as const) {
    const attempts: number[] = []
    const found = await firstSequential([1, 2], (n) => {
      attempts.push(n)
      return falsy
    })
    assertEquals(found, falsy)
    assertEquals(attempts, [1])
  }
})
