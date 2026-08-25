import { assertEquals } from '@std/assert'
import { TLS_SOURCES } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('TLS_SOURCES lists every stored source discriminator including Organization CA', () => {
  assertEquals(TLS_SOURCES, [
    'upload',
    'lets_encrypt',
    'self_signed',
    'organization_ca',
  ])
})
