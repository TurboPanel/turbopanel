import { assertEquals } from '@std/assert'
import { readinessPaths, readinessSchemas } from './readiness.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('readinessSchemas defines DaemonErrorResponse', () => {
  const schema = readinessSchemas.DaemonErrorResponse as {
    required: string[]
  }
  assertEquals(schema.required, ['error'])
})

test('readinessPaths documents install readiness probe responses', () => {
  assertEquals(Object.keys(readinessPaths), ['/api/daemon/v1/readiness'])
  const path = readinessPaths['/api/daemon/v1/readiness'] as {
    get: { summary: string }
  }
  assertEquals(path.get.summary, 'Install readiness probe')
})
