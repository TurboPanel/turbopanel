/**
 * Host-free coverage for the certificate choices offered per name and the
 * default each untouched name starts with.
 */

import { assertEquals } from '@std/assert'
import { type NameOptionFacts, nameCertificateOptions } from './name-certificate-options.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test} (Sonar only sees `test()`). */
const test = Deno.test.bind(Deno)

function facts(over: Partial<NameOptionFacts>): NameOptionFacts {
  return {
    hostname: 'app.example.net',
    reach: 'direct',
    bind: 'public',
    isHttp: true,
    acmeEnabled: true,
    dnsIssuance: false,
    covering: [],
    ...over,
  }
}

test('a name only a tunnel carries starts on the origin certificate', () => {
  assertEquals(nameCertificateOptions(facts({ reach: 'tunnel' })).default, 'cloudflare_origin')
})

test('a direct name on a public address starts on Lets Encrypt over HTTP', () => {
  assertEquals(nameCertificateOptions(facts({})).default, 'letsencrypt_http')
})

test('a direct name with a covering DNS token starts on Lets Encrypt over DNS', () => {
  assertEquals(nameCertificateOptions(facts({ dnsIssuance: true })).default, 'letsencrypt_dns')
})

test('a name on a tunnel and directly starts on DNS, else self-signed', () => {
  assertEquals(
    nameCertificateOptions(facts({ reach: 'tunnel_and_direct', dnsIssuance: true })).default,
    'letsencrypt_dns'
  )
  assertEquals(
    nameCertificateOptions(facts({ reach: 'tunnel_and_direct', bind: 'datacenter' })).default,
    'self_signed'
  )
})

test('without the organization setting or a public address the name starts self-signed', () => {
  assertEquals(nameCertificateOptions(facts({ acmeEnabled: false })).default, 'self_signed')
  assertEquals(nameCertificateOptions(facts({ bind: 'datacenter' })).default, 'self_signed')
})

test('disabled options say why and covering certificates are listed', () => {
  const result = nameCertificateOptions(
    facts({ covering: [{ id: 'wild', label: '*.example.net' }] })
  )
  const origin = result.options.find((o) => o.certificate === 'cloudflare_origin')
  assertEquals(origin?.available, false)
  assertEquals(typeof origin?.reason, 'string')
  assertEquals(
    result.options.filter((o) => o.certificate === 'library'),
    [{ certificate: 'library', tlsId: 'wild', label: '*.example.net', available: true }]
  )
  assertEquals(result.options.find((o) => o.certificate === 'self_signed')?.available, true)
})
