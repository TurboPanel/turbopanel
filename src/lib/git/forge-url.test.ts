import { assertEquals, assertThrows } from '@std/assert'
import { assertForgeUrlAllowed, ForgeUrlError, validateForgeUrl } from './forge-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('accepts the forges an admin can legitimately name', () => {
  for (const url of [
    'https://github.com',
    'https://github.com/',
    'https://gitlab.example.com:8443/',
    'https://ghe.corp.example.com/api/v3',
    ' https://gitlab.com ',
    // A public IP literal is unusual but not an SSRF vector.
    'https://203.0.113.10',
    'https://[2001:db8::10]:8443',
  ]) {
    assertEquals(validateForgeUrl(url), null, url)
  }
})

test('refuses anything that is not https', () => {
  assertEquals(validateForgeUrl('http://gitlab.example.com'), 'scheme_not_https')
  assertEquals(validateForgeUrl('ftp://gitlab.example.com'), 'scheme_not_https')
  assertEquals(validateForgeUrl('file:///etc/passwd'), 'scheme_not_https')
  assertEquals(validateForgeUrl('gitlab.example.com'), 'malformed')
  assertEquals(validateForgeUrl(''), 'malformed')
})

test('refuses embedded credentials', () => {
  assertEquals(validateForgeUrl('https://user:pw@gitlab.example.com'), 'credentials_in_url')
  assertEquals(validateForgeUrl('https://token@gitlab.example.com'), 'credentials_in_url')
})

test('refuses loopback, link-local, private and unusable IP literals', () => {
  for (const url of [
    'https://127.0.0.1:5432',
    'https://[::1]',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5',
    'https://172.16.4.4',
    'https://192.168.1.1',
    'https://100.64.0.1',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://0.0.0.0',
    'https://224.0.0.1',
    // IPv4-mapped IPv6 spelling of the loopback.
    'https://[::ffff:127.0.0.1]',
  ]) {
    assertEquals(validateForgeUrl(url), 'address_not_public', url)
  }
})

test('refuses reserved and single-label host names', () => {
  for (const url of [
    'https://localhost',
    'https://LOCALHOST:8443',
    'https://gitlab.localhost',
    'https://gitlab.local',
    'https://metadata.internal',
    'https://metadata.google.internal',
    'https://1.0.168.192.in-addr.arpa',
    'https://router.home.arpa',
    'https://postgres',
    'https://intranet:8080',
  ]) {
    assertEquals(validateForgeUrl(url), 'reserved_host', url)
  }
})

test('assertForgeUrlAllowed throws a typed error naming the field and reason', () => {
  assertEquals(assertForgeUrlAllowed('baseUrl', 'https://github.com'), 'https://github.com')
  const err = assertThrows(
    () => assertForgeUrlAllowed('apiUrl', 'https://127.0.0.1:5432'),
    ForgeUrlError,
  )
  assertEquals(err.field, 'apiUrl')
  assertEquals(err.reason, 'address_not_public')
})
