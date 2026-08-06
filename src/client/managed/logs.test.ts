import { assertEquals } from 'jsr:@std/assert'
import { clampManagedLogsTail, parseLogsTailQuery } from './logs.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('clampManagedLogsTail defaults and clamps to 1..2000', () => {
  assertEquals(clampManagedLogsTail(undefined), 200)
  assertEquals(clampManagedLogsTail(''), 200)
  assertEquals(clampManagedLogsTail('nope'), 200)
  assertEquals(clampManagedLogsTail('0'), 1)
  assertEquals(clampManagedLogsTail('-5'), 1)
  assertEquals(clampManagedLogsTail('50'), 50)
  assertEquals(clampManagedLogsTail('2000'), 2000)
  assertEquals(clampManagedLogsTail('9999'), 2000)
})

test('parseLogsTailQuery aliases clampManagedLogsTail', () => {
  assertEquals(parseLogsTailQuery(undefined), 200)
  assertEquals(parseLogsTailQuery('100'), 100)
})
