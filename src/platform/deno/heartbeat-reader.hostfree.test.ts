import { assertEquals } from '@std/assert'
import { createHeartbeatReader } from './heartbeat-reader.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('reader starts at 60, follows refreshes and keeps the last value on error', async () => {
  let modes: string[] | Error = []
  const errors: unknown[] = []
  const reader = createHeartbeatReader(
    () => (modes instanceof Error ? Promise.reject(modes) : Promise.resolve(modes)),
    (err) => errors.push(err)
  )
  assertEquals(reader.read(), 60)
  modes = ['cloudflare-tunnel']
  await reader.refresh()
  assertEquals(reader.read(), 25)
  modes = new Error('db down')
  await reader.refresh()
  assertEquals(reader.read(), 25)
  assertEquals(errors.length, 1)
})
