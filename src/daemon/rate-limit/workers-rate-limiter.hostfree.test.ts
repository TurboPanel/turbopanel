import { assertEquals } from '@std/assert'
import { createWorkersRateLimiter } from './workers-rate-limiter.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('createWorkersRateLimiter forwards the key to the binding', async () => {
  const seen: string[] = []
  const limiter = createWorkersRateLimiter({
    limit: (options) => {
      seen.push(options.key)
      return Promise.resolve({ success: options.key !== 'deny' })
    },
  })

  assertEquals(await limiter.limit({ key: 'allow' }), { success: true })
  assertEquals(await limiter.limit({ key: 'deny' }), { success: false })
  assertEquals(seen, ['allow', 'deny'])
})
