import { assert, assertEquals } from '@std/assert'
import { dnsNameTakenRefusal, dnsReplaceIncompleteRefusal, parseDoorwayBody } from './lifecycle.ts'
import { DnsNameTaken, DnsReplaceIncomplete } from './errors.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a hostname body takes the records the person agreed to replace, as they were shown', () => {
  assertEquals(parseDoorwayBody({ hostname: 'Shop.Example.com' }), {
    ok: true,
    value: { hostname: 'shop.example.com', isLocalOnly: true, replaceDnsRecords: [] },
  })
  const shown = [
    { id: 'rec-a', type: 'A', content: '192.0.2.10' },
    { id: 'rec_B1', type: 'AAAA', content: '2001:db8::10' },
  ]
  assertEquals(parseDoorwayBody({ hostname: 'a.example.com', replaceDnsRecords: shown }), {
    ok: true,
    value: { hostname: 'a.example.com', isLocalOnly: true, replaceDnsRecords: shown },
  })
  const one = shown[0]!
  for (const bad of [
    'rec-a',
    // Ids alone no longer confirm anything: type and content must come with them.
    ['rec-a'],
    [{ ...one, id: 'rec a' }],
    [one, one],
    [{ id: 'rec-a', type: 'A' }],
    [{ ...one, type: '' }],
    Array.from({ length: 11 }, (_, i) => ({ ...one, id: `rec-${i}` })),
  ]) {
    const parsed = parseDoorwayBody({ hostname: 'a.example.com', replaceDnsRecords: bad })
    assertEquals(parsed.ok ? null : parsed.field, 'replaceDnsRecords')
  }
})

test('more records than can be replaced at once are shown, but not offered for replacing', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    id: `rec-${i}`,
    type: 'A',
    content: `192.0.2.${i}`,
    proxied: false,
  }))
  const refusal = dnsNameTakenRefusal(new DnsNameTaken('a.example.com', many))
  assertEquals(refusal.details?.replaceable, false)
  assertEquals((refusal.details?.records as unknown[]).length, 11)
  assert(refusal.message.includes('remove them at your DNS provider first'))
  assert(!refusal.message.includes('Replace them'))
})

test('a replacement that did not finish is refused naming what was already removed', () => {
  const refusal = dnsReplaceIncompleteRefusal(
    new DnsReplaceIncomplete(
      'a.example.com',
      [{ type: 'AAAA', content: '2001:db8::10', proxied: true }],
      'the last write failed'
    )
  )
  assertEquals(refusal.code, 'dns_replace_incomplete')
  assertEquals(refusal.status, 502)
  assertEquals(refusal.details, {
    hostname: 'a.example.com',
    removedRecords: [{ type: 'AAAA', content: '2001:db8::10', proxied: true }],
  })
  assert(refusal.message.includes('Already removed: AAAA 2001:db8::10'))
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
    replaceable: true,
  })
})
