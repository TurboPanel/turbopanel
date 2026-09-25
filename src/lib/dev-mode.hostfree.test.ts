import { assertEquals } from '@std/assert'
import { isExplicitDevelopmentMode } from './dev-mode.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isExplicitDevelopmentMode is true only for TURBOPANEL_DEV_SURFACE=1', () => {
  const key = 'TURBOPANEL_DEV_SURFACE'
  const previous = Deno.env.get(key)
  try {
    Deno.env.delete(key)
    assertEquals(isExplicitDevelopmentMode(), false)

    Deno.env.set(key, '0')
    assertEquals(isExplicitDevelopmentMode(), false)

    Deno.env.set(key, ' 1 ')
    assertEquals(isExplicitDevelopmentMode(), true)

    Deno.env.set(key, '1')
    assertEquals(isExplicitDevelopmentMode(), true)
  } finally {
    if (previous === undefined) {
      Deno.env.delete(key)
    } else {
      Deno.env.set(key, previous)
    }
  }
})
