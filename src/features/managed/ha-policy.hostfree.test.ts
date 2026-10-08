import { assertEquals } from '@std/assert'
import { orchestratorManagesEngine } from './ha-policy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('orchestratorManagesEngine includes only MySQL-family engines', () => {
  assertEquals(orchestratorManagesEngine('mysql'), true)
  assertEquals(orchestratorManagesEngine('mariadb'), true)
  assertEquals(orchestratorManagesEngine('postgres'), false)
})
