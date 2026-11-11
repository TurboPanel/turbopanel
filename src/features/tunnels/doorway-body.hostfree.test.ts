import { assertEquals } from '@std/assert'
import { dnsNameTakenRefusal, parseDoorwayBody } from './lifecycle.ts'
import { DnsNameTaken } from './errors.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a hostname body takes the record ids the person agreed to replace, and nothing else', () => {
  assertEquals(parseDoorwayBody({ hostname: 'Shop.Example.com' }), {
    ok: true,
    value: { hostname: 'shop.example.com', isLocalOnly: true, replaceDnsRecords: [] },
  })
  assertEquals(
    parseDoorwayBody({ hostname: 'a.example.com', replaceDnsRecords: ['rec-a', 'rec_B1'] }),
    {
      ok: true,
      value: {
        hostname: 'a.example.com',
        isLocalOnly: true,
        replaceDnsRecords: ['rec-a', 'rec_B1'],
      },
    }
  )
  for (const bad of [
    'rec-a',
    ['rec a'],
    ['rec-a', 'rec-a'],
    [1],
    Array.from({ length: 11 }, (_, i) => `rec-${i}`),
  ]) {
    const parsed = parseDoorwayBody({ hostname: 'a.example.com', replaceDnsRecords: bad })
    assertEquals(parsed.ok ? null : parsed.field, 'replaceDnsRecords')
  }
})

test('a name held by other records is refused with them, in plain words', () => {
  const one = dnsNameTakenRefusal(
    new DnsNameTaken('a.example.com', [
      { id: 'rec-a', type: 'CNAME', content: 'old.example.net', proxied: true },
    ])
  )
  assertEquals(one.code, 'dns_record_exists')
  assertEquals(one.status, 409)
  assertEquals(
    one.message,
    'A DNS record for a.example.com already exists: CNAME old.example.net (proxied). Replace it to point the name at this Tunnel, or remove it at your DNS provider first.'
  )
  assertEquals(one.details, {
    hostname: 'a.example.com',
    records: [{ id: 'rec-a', type: 'CNAME', content: 'old.example.net', proxied: true }],
  })
})
