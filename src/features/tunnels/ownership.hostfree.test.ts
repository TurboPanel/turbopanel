import { assertThrows } from '@std/assert'
import { assertSameHostingOrganization, TunnelOrganizationError } from './ownership.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a tunnel hosting another organization is refused, the same organization is fine', () => {
  assertSameHostingOrganization('org-a', 'org-a')
  assertThrows(() => assertSameHostingOrganization('org-a', 'org-b'), TunnelOrganizationError)
})
