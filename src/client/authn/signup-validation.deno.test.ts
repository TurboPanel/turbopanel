import { assertEquals } from '@std/assert'
import { parseSignupBody } from './http.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 *
 * Deno twin of signup-validation.workers.test.ts (Vitest) so Sonar LCOV can attribute
 * parseSignupBody coverage from the Deno coverage profile.
 */
const test = Deno.test.bind(Deno)

const email = 'new-user@example.com'

test('parseSignupBody rejects a password with no digit or special character', () => {
  const result = parseSignupBody({ email, password: 'abcdefgh' })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.error, 'Password must include at least one number')
  }
})

test('parseSignupBody rejects a digits-only password (no special character)', () => {
  const result = parseSignupBody({ email, password: '12345678' })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.error,
      'Password must include at least one special character',
    )
  }
})

test('parseSignupBody rejects a password with leading/trailing whitespace', () => {
  const result = parseSignupBody({ email, password: ' passw0rd! ' })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(
      result.error,
      'Password must not have leading or trailing whitespace',
    )
  }
})

test('parseSignupBody accepts a password that satisfies every rule', () => {
  const result = parseSignupBody({ email, password: 'sup3r-secret!' })
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.email, email)
    assertEquals(result.password, 'sup3r-secret!')
  }
})

test('parseSignupBody accepts an optional invitationId UUID and rejects a malformed one', () => {
  const invitationId = '11111111-1111-4111-8111-111111111111'
  const accepted = parseSignupBody({
    email,
    password: 'sup3r-secret!',
    invitationId,
  })
  assertEquals(accepted.ok, true)
  if (accepted.ok) {
    assertEquals(accepted.invitationId, invitationId)
  }

  const rejected = parseSignupBody({
    email,
    password: 'sup3r-secret!',
    invitationId: 'not-a-uuid',
  })
  assertEquals(rejected.ok, false)
  if (!rejected.ok) {
    assertEquals(rejected.error, 'Invalid request')
  }
})

test('parseSignupBody rejects non-objects and missing fields', () => {
  assertEquals(parseSignupBody(null).ok, false)
  assertEquals(parseSignupBody([]).ok, false)
  assertEquals(parseSignupBody({ email }).ok, false)
  assertEquals(parseSignupBody({ password: 'sup3r-secret!' }).ok, false)
})
