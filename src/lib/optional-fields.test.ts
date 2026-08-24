import { assertEquals } from '@std/assert'
import { definedFields, presentFields } from './optional-fields.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('definedFields drops only undefined values', () => {
  const fields = definedFields({
    a: 'kept',
    b: undefined,
    c: null,
    d: 0,
    e: '',
    f: [] as string[],
  })
  assertEquals(Object.keys(fields), ['a', 'c', 'd', 'e', 'f'])
  assertEquals(fields.a, 'kept')
})

test('definedFields leaves an all-present object untouched', () => {
  assertEquals(definedFields({ a: 1, b: 2 }), { a: 1, b: 2 })
})

test('presentFields drops undefined and empty arrays', () => {
  const fields = presentFields({
    kept: ['one'],
    empty: [] as string[],
    missing: undefined,
    zero: 0,
    nulled: null,
  })
  assertEquals(Object.keys(fields), ['kept', 'zero', 'nulled'])
  assertEquals(fields.kept, ['one'])
})

test('presentFields keeps a non-array falsy value', () => {
  assertEquals(presentFields({ noCache: false }), { noCache: false })
})
