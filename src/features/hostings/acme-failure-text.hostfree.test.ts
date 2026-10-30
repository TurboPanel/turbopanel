/**
 * Host-free coverage for the plain words of a reported certificate failure.
 */

import { assertEquals } from '@std/assert'
import { plainCertificateFailure } from './acme-failure-text.ts'

/** Alias for {@link Deno.test} so Sonar sees real tests. */
const test = Deno.test.bind(Deno)

const NO_DNS_RAW =
  'fetch failed: error sending request for url (https://tptest-cs2.munch.ws/): client error (Connect): dns error: failed to lookup address information: Name or service not known'

test('a name with no DNS record says so in one sentence', () => {
  const text = plainCertificateFailure(NO_DNS_RAW, 'tptest-cs2.munch.ws')
  assertEquals(text.startsWith('tptest-cs2.munch.ws has no DNS record yet'), true)
  assertEquals(text.includes('fetch failed'), false)
})

test('the name is read from the raw text when the caller does not know it', () => {
  assertEquals(
    plainCertificateFailure(NO_DNS_RAW).startsWith('tptest-cs2.munch.ws has no DNS record yet'),
    true
  )
})

test('a refusal, a timeout and an untrusted certificate each get their own sentence', () => {
  const refused = 'fetch failed: tcp connect error: Connection refused (os error 111)'
  assertEquals(
    plainCertificateFailure(refused, 'a.example.com'),
    'Nothing answered on port 443 at a.example.com, so the server could not check its certificate.'
  )
  assertEquals(
    plainCertificateFailure('fetch failed: operation timed out', 'a.example.com').startsWith(
      'a.example.com did not answer in time'
    ),
    true
  )
  assertEquals(
    plainCertificateFailure(
      'fetch failed: client error (Connect): invalid peer certificate: UnknownIssuer',
      'a.example.com'
    ).startsWith('a.example.com still shows a certificate'),
    true
  )
})

test("the authority's own reason is kept", () => {
  const reason = 'DNS problem: NXDOMAIN looking up A for a.example.com'
  assertEquals(plainCertificateFailure(reason, 'a.example.com'), reason)
})
