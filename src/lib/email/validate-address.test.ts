import { assertEquals, assertThrows } from '@std/assert'
import {
  PermanentSendError,
  validateEmailAddress,
} from './validate-address.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('validateEmailAddress accepts plain addresses', () => {
  validateEmailAddress('ops@example.com', 'to')
})

test('validateEmailAddress accepts display-name form', () => {
  validateEmailAddress('Ops <ops@example.com>', 'from')
})

test('validateEmailAddress rejects empty and malformed', () => {
  assertThrows(
    () => validateEmailAddress('', 'to'),
    PermanentSendError,
    'malformed to address',
  )
  assertThrows(
    () => validateEmailAddress('not-an-email', 'to'),
    PermanentSendError,
  )
  assertThrows(
    () => validateEmailAddress('a@b', 'to'),
    PermanentSendError,
  )
  assertThrows(
    () => validateEmailAddress('a@@example.com', 'to'),
    PermanentSendError,
  )
  assertThrows(
    () => validateEmailAddress('a @example.com', 'to'),
    PermanentSendError,
  )
})

test('validateEmailAddress trims display-name addresses', () => {
  validateEmailAddress('  Ops Team <ops@example.com>  ', 'to')
})

test('validateEmailAddress rejects display-name with malformed inner address', () => {
  assertThrows(
    () => validateEmailAddress('Ops <not-an-email>', 'to'),
    PermanentSendError,
    'malformed to address',
  )
})

test('PermanentSendError is an Error subclass', () => {
  const err = new PermanentSendError('boom')
  assertEquals(err instanceof Error, true)
  assertEquals(err.message, 'boom')
})
