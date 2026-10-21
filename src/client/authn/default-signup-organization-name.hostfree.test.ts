import { assertEquals } from '@std/assert'
import { DISPLAY_NAME_MAX_LENGTH } from '../../lib/display-name-format.ts'
import {
  MY_ORGANIZATION_NAME,
  resolveDefaultSignupOrganizationName,
  SIGNUP_ORGANIZATION_NAME_SUFFIX,
} from './default-signup-organization-name.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveDefaultSignupOrganizationName uses email plus apostrophe-s suffix', () => {
  assertEquals(
    resolveDefaultSignupOrganizationName('james@example.com'),
    "james@example.com's organization"
  )
})

test('resolveDefaultSignupOrganizationName normalizes email like sign-up', () => {
  assertEquals(
    resolveDefaultSignupOrganizationName('  James@Example.COM  '),
    "james@example.com's organization"
  )
})

test('resolveDefaultSignupOrganizationName falls back when email is missing or blank', () => {
  assertEquals(resolveDefaultSignupOrganizationName(undefined), MY_ORGANIZATION_NAME)
  assertEquals(resolveDefaultSignupOrganizationName(null), MY_ORGANIZATION_NAME)
  assertEquals(resolveDefaultSignupOrganizationName(''), MY_ORGANIZATION_NAME)
  assertEquals(resolveDefaultSignupOrganizationName('   '), MY_ORGANIZATION_NAME)
})

test('resolveDefaultSignupOrganizationName truncates a long email without splitting the suffix', () => {
  const suffixLen = [...SIGNUP_ORGANIZATION_NAME_SUFFIX].length
  const longLocal = 'a'.repeat(DISPLAY_NAME_MAX_LENGTH)
  const email = `${longLocal}@example.com`
  const resolved = resolveDefaultSignupOrganizationName(email)
  assertEquals(resolved.endsWith(SIGNUP_ORGANIZATION_NAME_SUFFIX), true)
  assertEquals([...resolved].length, DISPLAY_NAME_MAX_LENGTH)
  assertEquals(
    resolved,
    `${'a'.repeat(DISPLAY_NAME_MAX_LENGTH - suffixLen)}${SIGNUP_ORGANIZATION_NAME_SUFFIX}`
  )
})
