import { assertEquals } from '@std/assert'
import {
  attachPrivateCidrs,
  mergeDatacenterMetadata,
  parseMemberPins,
  parseNameSuggestionsQuery,
  parseOptionalUuid,
  parseRequiredCidr,
  resolveSeededFields,
} from './create-input.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mergeDatacenterMetadata prefers request metadata over seeded defaults', () => {
  assertEquals(
    mergeDatacenterMetadata({ geo: { city: 'Amsterdam' } }, { note: 'ops' }),
    { geo: { city: 'Amsterdam' }, note: 'ops' },
  )
  assertEquals(
    mergeDatacenterMetadata({ geo: { city: 'Amsterdam' } }, null),
    { geo: { city: 'Amsterdam' } },
  )
  assertEquals(mergeDatacenterMetadata(null, { note: 'ops' }), { note: 'ops' })
})

test('parseMemberPins validates UUID + address pairs and rejects duplicates', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000'
  const otherId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: otherId, address: '10.0.0.11' },
    ]),
    {
      ok: true,
      value: [
        { serverId: validId, address: '10.0.0.10' },
        { serverId: otherId, address: '10.0.0.11' },
      ],
    },
  )
  assertEquals(parseMemberPins(undefined), { ok: false })
  assertEquals(parseMemberPins([]), { ok: false })
  assertEquals(parseMemberPins([{ serverId: 'not-a-uuid', address: '10.0.0.1' }]), {
    ok: false,
  })
  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: validId, address: '10.0.0.11' },
    ]),
    {
      ok: true,
      value: [
        { serverId: validId, address: '10.0.0.10' },
        { serverId: validId, address: '10.0.0.11' },
      ],
    },
  )
  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: otherId, address: '10.0.0.10' },
    ]),
    { ok: false },
  )
  assertEquals(
    parseMemberPins([
      { serverId: validId, address: '10.0.0.10' },
      { serverId: validId, address: '10.0.0.10' },
    ]),
    { ok: false },
  )
  assertEquals(
    parseMemberPins(Array.from({ length: 65 }, (_, i) => ({
      serverId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`,
      address: `10.${String(Math.floor(i / 256))}.${String(Math.floor((i % 256) / 256))}.${String(i % 256)}`,
    }))),
    { ok: false },
  )
})

test('parseRequiredCidr accepts valid CIDRs only', () => {
  assertEquals(parseRequiredCidr('10.0.0.0/24'), { ok: true, value: '10.0.0.0/24' })
  assertEquals(parseRequiredCidr(' 10.0.0.0/24 '), { ok: true, value: '10.0.0.0/24' })
  assertEquals(parseRequiredCidr('not-a-cidr'), { ok: false })
  assertEquals(parseRequiredCidr(undefined), { ok: false })
})

test('resolveSeededFields fills name and metadata from source server geo', () => {
  const seeded = resolveSeededFields(
    {
      name: null,
      description: null,
      metadata: { operatorNote: 'edge' },
      options: null,
      sourceServerId: 'server-a',
      members: [{ serverId: 'server-a', address: '10.0.0.10' }],
    },
    [{
      id: 'server-a',
      metadata: {
        geo: {
          city: 'Amsterdam',
          country: 'NL',
          asn: 13335,
          asOrganization: 'Cloudflare',
        },
      },
    }],
  )

  assertEquals(seeded.name, 'Amsterdam NL - Cloudflare AS13335')
  assertEquals(seeded.metadata?.operatorNote, 'edge')
  assertEquals(
    (seeded.metadata as Record<string, unknown>).seededFromServerId,
    'server-a',
  )

  const passthrough = resolveSeededFields(
    {
      name: 'Custom DC',
      description: null,
      metadata: null,
      options: null,
      sourceServerId: null,
      members: [],
    },
    [],
  )
  assertEquals(passthrough.name, 'Custom DC')
  assertEquals(passthrough.metadata, null)
})

test('parseOptionalUuid accepts null and valid UUIDs only', () => {
  const valid = '550e8400-e29b-41d4-a716-446655440000'
  assertEquals(parseOptionalUuid(undefined), { ok: true, value: null })
  assertEquals(parseOptionalUuid(valid), { ok: true, value: valid })
  assertEquals(parseOptionalUuid('not-a-uuid'), { ok: false })
})

test('attachPrivateCidrs joins datacenter network CIDR lists', () => {
  const rows = [{ id: 'dc-a', displayName: 'Site A' }]
  const cidrs = new Map([['dc-a', ['10.0.0.0/24', '10.0.1.0/24']]])
  assertEquals(attachPrivateCidrs(rows, cidrs), [{
    id: 'dc-a',
    displayName: 'Site A',
    privateCidrs: ['10.0.0.0/24', '10.0.1.0/24'],
  }])
  assertEquals(attachPrivateCidrs([{ id: 'dc-b' }], cidrs)[0].privateCidrs, [])
})

test('parseNameSuggestionsQuery validates limit and unassignedOnly flag', () => {
  assertEquals(parseNameSuggestionsQuery(undefined, undefined), {
    unassignedOnly: true,
    limit: 8,
  })
  assertEquals(parseNameSuggestionsQuery('0', '16'), {
    unassignedOnly: false,
    limit: 16,
  })
  assertEquals(parseNameSuggestionsQuery(undefined, '-1'), 'invalid')
  assertEquals(parseNameSuggestionsQuery(undefined, '33'), 'invalid')
})
