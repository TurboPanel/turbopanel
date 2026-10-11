import { assertEquals, assertThrows } from '@std/assert'
import {
  parseSingleEmailAddress,
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
  assertThrows(() => validateEmailAddress('', 'to'), PermanentSendError, 'malformed to address')
  assertThrows(() => validateEmailAddress('not-an-email', 'to'), PermanentSendError)
  assertThrows(() => validateEmailAddress('a@b', 'to'), PermanentSendError)
  assertThrows(() => validateEmailAddress('a@@example.com', 'to'), PermanentSendError)
  assertThrows(() => validateEmailAddress('a @example.com', 'to'), PermanentSendError)
})

test('validateEmailAddress trims display-name addresses', () => {
  validateEmailAddress('  Ops Team <ops@example.com>  ', 'to')
})

test('validateEmailAddress rejects display-name with malformed inner address', () => {
  assertThrows(
    () => validateEmailAddress('Ops <not-an-email>', 'to'),
    PermanentSendError,
    'malformed to address'
  )
})

test('validateEmailAddress rejects domains without a dot', () => {
  assertThrows(
    () => validateEmailAddress('user@localhost', 'from'),
    PermanentSendError,
    'malformed from address'
  )
})

test('validateEmailAddress accepts subdomains and plus tags', () => {
  validateEmailAddress('ops+alerts@mail.example.com', 'to')
  validateEmailAddress('Team <ops+alerts@mail.example.com>', 'to')
})

test('PermanentSendError is an Error subclass', () => {
  const err = new PermanentSendError('boom')
  assertEquals(err instanceof Error, true)
  assertEquals(err.message, 'boom')
})

test('validateEmailAddress refuses a list of recipients in any spelling', () => {
  for (const raw of [
    'a@example.com, b@example.org',
    'a@example.com,b@example.org',
    'a@example.com; b@example.org',
    'Ops <a@example.com>, b@example.org',
    'a@example.com, Ops <b@example.org>',
    'Ops <a@example.com>\r\nBcc: b@example.org',
    'a@example.com\nb@example.org',
    'Ops <a@example.com> <b@example.org>',
  ]) {
    assertThrows(() => validateEmailAddress(raw, 'recipient'), PermanentSendError, undefined, raw)
  }
})

test('validateEmailAddress still takes a quoted display name that holds a comma', () => {
  validateEmailAddress('"Ops, Inc." <ops@example.com>', 'from')
})

test('parseSingleEmailAddress returns exactly one bare address or null', () => {
  assertEquals(parseSingleEmailAddress(' Ops@Example.com '), 'Ops@Example.com')
  assertEquals(parseSingleEmailAddress('Ops <ops@example.com>'), 'ops@example.com')
  for (const raw of [
    '',
    'nope',
    'a@example.com, b@example.org',
    'a@example.com;b@example.org',
    'a@example.com\nb@example.org',
    '<a@example.com>x',
    'a b@example.com',
    '"a"@example.com',
    `${'a'.repeat(65)}@example.com`,
    `a@${'b'.repeat(250)}.com`,
  ]) {
    assertEquals(parseSingleEmailAddress(raw), null, raw)
  }
})
