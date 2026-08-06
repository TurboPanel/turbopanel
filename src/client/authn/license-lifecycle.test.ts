import { assertEquals } from 'jsr:@std/assert'
import { assertLicenseInvalidationAllowed } from './license-lifecycle.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('assertLicenseInvalidationAllowed always allows on deno', async () => {
  assertEquals(
    await assertLicenseInvalidationAllowed(
      'deno',
      '00000000-0000-4000-8000-000000000001',
    ),
    null,
  )
})

test('assertLicenseInvalidationAllowed always allows on workers', async () => {
  assertEquals(
    await assertLicenseInvalidationAllowed(
      'workers',
      '00000000-0000-4000-8000-000000000002',
    ),
    null,
  )
})
