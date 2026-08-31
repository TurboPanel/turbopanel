import { assertEquals } from '@std/assert'
import {
  composePrincipalAliases,
  unionAliasSets,
} from './principal-alias-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('composePrincipalAliases reads the root block of a compose option', () => {
  assertEquals(
    [...composePrincipalAliases({
      compose: {
        version: 1,
        data: {
          services: {},
          'x-turbopanel': { principals: { web: {}, worker: { access: 'sftp' } } },
        },
        presentation: { keyOrder: ['services'], comments: {} },
      },
    })].sort(),
    ['web', 'worker'],
  )
})

test('composePrincipalAliases is empty for anything unusable', () => {
  // Never throws: this runs on request bodies, which can be anything.
  for (const input of [null, undefined, 7, {}, { compose: 'nope' }]) {
    assertEquals(composePrincipalAliases(input).size, 0)
  }
})

test('composePrincipalAliases drops an entry the parser refuses', () => {
  // Reads the normalized root, not raw keys — an alias the parser would drop as
  // unusable is not "declared" for the resolution rule either.
  assertEquals(
    [...composePrincipalAliases({
      compose: {
        version: 1,
        data: {
          services: {},
          'x-turbopanel': { principals: { ok: {}, '9bad': {} } },
        },
        presentation: { keyOrder: ['services'], comments: {} },
      },
    })],
    ['ok'],
  )
})

test('unionAliasSets merges the overlay case', () => {
  assertEquals(
    [...unionAliasSets(new Set(['base']), new Set(['own', 'base']))].sort(),
    ['base', 'own'],
  )
  assertEquals(unionAliasSets().size, 0)
})
