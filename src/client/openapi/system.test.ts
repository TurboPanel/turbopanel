import { assertEquals } from '@std/assert'
import { systemPaths } from './system.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('systemPaths keys include the client API prefix', () => {
  assertEquals(
    Object.keys(systemPaths).sort((a, b) => a.localeCompare(b)),
    ['/api/client/v1/servers/{id}/system/{component}/restart'],
  )
})
