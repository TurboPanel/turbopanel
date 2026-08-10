import { assertEquals } from '@std/assert'
import {
  attachPrivateCidrs,
  collectServerIdsToAssign,
  mergeDatacenterMetadata,
  parseAssignServerIds,
  parseNameSuggestionsQuery,
  parseOptionalUuid,
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

test('parseAssignServerIds deduplicates and validates UUIDs', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000'
  const otherId = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

  assertEquals(parseAssignServerIds(undefined), { ok: true, value: [] })
  assertEquals(parseAssignServerIds([validId, validId, otherId]), {
    ok: true,
    value: [validId, otherId],
  })
  assertEquals(parseAssignServerIds(['not-a-uuid']), { ok: false })
  assertEquals(parseAssignServerIds(Array.from({ length: 65 }, () => validId)), {
    ok: false,
  })
})

test('resolveSeededFields fills name and metadata from source server geo', () => {
  const seeded = resolveSeededFields(
    {
      name: null,
      description: null,
      metadata: { operatorNote: 'edge' },
      options: null,
      sourceServerId: 'server-a',
      assignServerIds: ['server-a'],
    },
    [{
      id: 'server-a',
      datacenterId: null,
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
      assignServerIds: [],
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

test('collectServerIdsToAssign deduplicates source and assign ids', () => {
  const source = '550e8400-e29b-41d4-a716-446655440000'
  const other = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
  assertEquals(
    collectServerIdsToAssign({
      name: null,
      description: null,
      metadata: null,
      options: null,
      sourceServerId: source,
      assignServerIds: [source, other],
    }).sort((a, b) => a.localeCompare(b)),
    [source, other].sort((a, b) => a.localeCompare(b)),
  )
})
