import { assertEquals } from '@std/assert'
import { parseManagedOrganizationDefaults, parseManagedSslModeInput } from './org-defaults.ts'
import {
  DEFAULT_MANAGED_SSL_MODE,
  isManagedSslMode,
  MANAGED_SSL_MODES,
  managedSslRequiresTls,
  managedSslVerifiesServer,
  mysqlFamilySslMode,
  parseManagedSslMode,
  resolveManagedSslMode,
} from './ssl.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('the mode list is ordered weakest to strongest and defaults to require', () => {
  assertEquals(MANAGED_SSL_MODES, [
    'disable',
    'allow',
    'prefer',
    'require',
    'verify-ca',
    'verify-full',
  ])
  assertEquals(DEFAULT_MANAGED_SSL_MODE, 'require')
  assertEquals(MANAGED_SSL_MODES.includes(DEFAULT_MANAGED_SSL_MODE), true)
})

test('isManagedSslMode accepts only catalog values', () => {
  for (const mode of MANAGED_SSL_MODES) {
    assertEquals(isManagedSslMode(mode), true)
  }
  for (const bogus of ['REQUIRE', 'verify_full', 'on', '', 1, null, {}]) {
    assertEquals(isManagedSslMode(bogus), false)
  }
})

test('parseManagedSslMode separates "inherit" from "invalid"', () => {
  // `undefined` is a real state (no override); `null` is a rejection.
  assertEquals(parseManagedSslMode(undefined), undefined)
  assertEquals(parseManagedSslMode('verify-full'), 'verify-full')
  assertEquals(parseManagedSslMode('requrie'), null)
  assertEquals(parseManagedSslMode(false), null)
})

test('resolveManagedSslMode walks service override then org default', () => {
  assertEquals(resolveManagedSslMode(undefined, undefined), 'require')
  assertEquals(resolveManagedSslMode(undefined, 'verify-full'), 'verify-full')
  // A service override wins over a stricter org default.
  assertEquals(resolveManagedSslMode('prefer', 'verify-full'), 'prefer')
  assertEquals(resolveManagedSslMode('disable'), 'disable')
})

test('only require and the verify modes force TLS on the frontend', () => {
  assertEquals(MANAGED_SSL_MODES.filter(managedSslRequiresTls), [
    'require',
    'verify-ca',
    'verify-full',
  ])
  assertEquals(MANAGED_SSL_MODES.filter(managedSslVerifiesServer), [
    'verify-ca',
    'verify-full',
  ])
})

test('MySQL-family spelling collapses allow/prefer and renames the verify modes', () => {
  assertEquals(
    MANAGED_SSL_MODES.map(mysqlFamilySslMode),
    [
      'DISABLED',
      'PREFERRED',
      'PREFERRED',
      'REQUIRED',
      'VERIFY_CA',
      'VERIFY_IDENTITY',
    ],
  )
})

test('org defaults parsing drops malformed jsonb instead of failing the read', () => {
  assertEquals(parseManagedOrganizationDefaults(undefined), {})
  assertEquals(parseManagedOrganizationDefaults(null), {})
  assertEquals(parseManagedOrganizationDefaults('require'), {})
  assertEquals(parseManagedOrganizationDefaults([]), {})
  assertEquals(
    parseManagedOrganizationDefaults({ sslMode: 'verify-ca' }),
    { sslMode: 'verify-ca' },
  )
  // A bad stored value inherits rather than making the org unreadable.
  assertEquals(parseManagedOrganizationDefaults({ sslMode: 'nope' }), {})
  assertEquals(parseManagedOrganizationDefaults({ other: 1 }), {})
})

test('PUT body parsing distinguishes clearing from an invalid mode', () => {
  assertEquals(parseManagedSslModeInput(null), { ok: true, value: null })
  assertEquals(parseManagedSslModeInput('prefer'), {
    ok: true,
    value: 'prefer',
  })
  assertEquals(parseManagedSslModeInput('nope'), { ok: false })
  // Unlike the stored read path, omitting the value is not a silent no-op here.
  assertEquals(parseManagedSslModeInput(undefined), { ok: false })
})
