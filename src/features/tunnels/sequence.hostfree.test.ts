import { assertEquals, assertRejects } from '@std/assert'
import { firstResult, inSequence } from './sequence.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('items run one after another, in order, and the results come back in order', async () => {
  const log: string[] = []
  const slow = async (name: string, ms: number) => {
    log.push(`start ${name}`)
    await new Promise((resolve) => setTimeout(resolve, ms))
    log.push(`end ${name}`)
    return name.toUpperCase()
  }
  const out = await inSequence([['a', 20] as const, ['b', 1] as const], ([n, ms]) => slow(n, ms))
  assertEquals(out, ['A', 'B'])
  assertEquals(log, ['start a', 'end a', 'start b', 'end b'])
  assertEquals(await inSequence([], () => Promise.resolve(1)), [])
})

test('a failure stops the sequence and later items do not run', async () => {
  const seen: number[] = []
  await assertRejects(
    () =>
      inSequence([1, 2, 3], (n) => {
        seen.push(n)
        return n === 2 ? Promise.reject(new Error('stop')) : Promise.resolve(n)
      }),
    Error,
    'stop'
  )
  assertEquals(seen, [1, 2])
})

test('the first item that gives a result wins and the rest are not tried', async () => {
  const tried: number[] = []
  const found = await firstResult([1, 2, 3, 4], (n) => {
    tried.push(n)
    return Promise.resolve(n >= 2 ? `got ${n}` : undefined)
  })
  assertEquals(found, 'got 2')
  assertEquals(tried, [1, 2])
  assertEquals(await firstResult([1, 2], () => Promise.resolve(undefined)), undefined)
  assertEquals(await firstResult([], () => Promise.resolve('x')), undefined)
})
