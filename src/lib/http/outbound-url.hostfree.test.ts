/**
 * The shared "will this instance dial it" rule, tested here rather than only
 * through its callers — forge URLs were the first caller, not the only one.
 */

import { assertEquals } from '@std/assert'
import { hostIsReserved, unbracket, validateOutboundUrl } from './outbound-url.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a public https URL is dialable', () => {
  assertEquals(validateOutboundUrl('https://gitlab.example.com/api/v4'), null)
  assertEquals(validateOutboundUrl('  https://hooks.slack.com/x  '), null)
  // A public IP literal is unusual but not an SSRF vector.
  assertEquals(validateOutboundUrl('https://93.184.216.34/x'), null)
})

test('the refusals, one per reason', () => {
  assertEquals(validateOutboundUrl('nonsense'), 'malformed')
  assertEquals(validateOutboundUrl('http://example.com'), 'scheme_not_https')
  assertEquals(validateOutboundUrl('ftp://example.com'), 'scheme_not_https')
  assertEquals(
    validateOutboundUrl('https://u:p@example.com'),
    'credentials_in_url',
  )
  assertEquals(validateOutboundUrl('https://localhost'), 'reserved_host')
  assertEquals(validateOutboundUrl('https://redis'), 'reserved_host')
  assertEquals(validateOutboundUrl('https://x.localhost'), 'reserved_host')
  assertEquals(validateOutboundUrl('https://x.internal'), 'reserved_host')
  assertEquals(validateOutboundUrl('https://x.home.arpa'), 'reserved_host')
  assertEquals(validateOutboundUrl('https://127.0.0.1'), 'address_not_public')
  assertEquals(validateOutboundUrl('https://[::1]'), 'address_not_public')
  // The cloud metadata endpoint, the single most valuable SSRF target.
  assertEquals(
    validateOutboundUrl('https://169.254.169.254/latest/meta-data'),
    'address_not_public',
  )
  assertEquals(validateOutboundUrl('https://192.168.1.1'), 'address_not_public')
})

test('a bare single-label host is reserved — Docker service names resolve', () => {
  assertEquals(hostIsReserved('postgres'), true)
  assertEquals(hostIsReserved('intranet'), true)
  assertEquals(hostIsReserved('example.com'), false)
})

test('an IPv6 literal is unbracketed before it is classified', () => {
  assertEquals(unbracket('[::1]'), '::1')
  assertEquals(unbracket('example.com'), 'example.com')
})
