import { assertEquals } from '@std/assert'
import { createClosablePause } from './closable-pause.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}; Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno)

test('closable pause resolves after its time', async () => {
  const waits = createClosablePause()
  let done = false
  const waiting = waits.pause(5).then(() => {
    done = true
  })
  assertEquals(done, false)
  await waiting
  assertEquals(done, true)
})

test('close ends every pending pause at once and later pauses resolve immediately', async () => {
  const waits = createClosablePause()
  const settled: number[] = []
  const first = waits.pause(60_000).then(() => settled.push(1))
  const second = waits.pause(60_000).then(() => settled.push(2))
  waits.close()
  await Promise.all([first, second])
  assertEquals(
    settled.sort((a, b) => a - b),
    [1, 2]
  )
  // Would leave a 60 s timer (and fail the op sanitizer) if close did not apply.
  await waits.pause(60_000)
})
