import { assert, assertEquals } from '@std/assert'
import {
  isRepositoryReadUnsupported,
  MAX_REPOSITORY_FILE_BYTES,
  MAX_REPOSITORY_READ_PATHS,
} from './repository-read.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isRepositoryReadUnsupported recognizes the unsupported marker', () => {
  assert(isRepositoryReadUnsupported({ unsupported: true }))
  assertEquals(isRepositoryReadUnsupported({ failure: 'nope' }), false)
  assertEquals(isRepositoryReadUnsupported(null), false)
})

test('repository read caps are fixed constants', () => {
  assertEquals(MAX_REPOSITORY_READ_PATHS, 8)
  assertEquals(MAX_REPOSITORY_FILE_BYTES, 256 * 1024)
})
