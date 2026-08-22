import { assertEquals } from '@std/assert'
import { caPaths } from './ca.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('caPaths exposes the platform CA download route', () => {
  assertEquals(Object.keys(caPaths), ['/api/daemon/v1/instance/ca'])
  const path = caPaths['/api/daemon/v1/instance/ca'] as {
    get: { summary: string }
  }
  assertEquals(path.get.summary, 'Platform TLS CA certificate')
})
