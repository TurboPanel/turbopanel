import { assertEquals } from '@std/assert'
import {
  isPostgresUniqueViolation,
  isUniqueViolationOn,
  uniqueViolationMessage,
} from './unique-violation.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const PG_UNIQUE = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "user_email_key"',
}

test('isPostgresUniqueViolation walks the cause chain', () => {
  const wrapped = {
    message: 'Failed query: insert …',
    cause: {
      message: 'connection reset',
      cause: PG_UNIQUE,
    },
  }
  assertEquals(isPostgresUniqueViolation(wrapped), true)
  assertEquals(
    uniqueViolationMessage(wrapped),
    PG_UNIQUE.message,
  )
  assertEquals(isUniqueViolationOn(wrapped, 'user_email_key'), true)
  assertEquals(isUniqueViolationOn(wrapped, 'other_idx'), false)
})

test('isPostgresUniqueViolation rejects unrelated errors', () => {
  assertEquals(isPostgresUniqueViolation({ code: '23503' }), false)
  assertEquals(uniqueViolationMessage(new Error('nope')), null)
  assertEquals(isPostgresUniqueViolation('string'), false)
})

test('cause chain depth is capped', () => {
  let inner: unknown = PG_UNIQUE
  for (let i = 0; i < 6; i += 1) {
    inner = { cause: inner }
  }
  assertEquals(isPostgresUniqueViolation(inner), false)
})
