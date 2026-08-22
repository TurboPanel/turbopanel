import { assertEquals } from '@std/assert'
import {
  buildSeededDatacenterMetadata,
  parseDatacenterMetadata,
} from './datacenter-metadata.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_ID = '11111111-1111-4111-8111-111111111111'

test('parseDatacenterMetadata returns empty object for non-records', () => {
  assertEquals(parseDatacenterMetadata(null), {})
  assertEquals(parseDatacenterMetadata([]), {})
  assertEquals(parseDatacenterMetadata('nope'), {})
})

test('parseDatacenterMetadata reads geo and seed fields', () => {
  assertEquals(
    parseDatacenterMetadata({
      geo: { country: 'US', city: 'Chicago' },
      seededFromServerId: `  ${SERVER_ID}  `,
      seededAt: ' 2026-01-01T00:00:00.000Z ',
    }),
    {
      geo: { country: 'US', city: 'Chicago' },
      seededFromServerId: SERVER_ID,
      seededAt: '2026-01-01T00:00:00.000Z',
    },
  )
})

test('parseDatacenterMetadata drops invalid geo and blank seed fields', () => {
  assertEquals(
    parseDatacenterMetadata({
      geo: { city: '' },
      seededFromServerId: '   ',
      seededAt: '',
    }),
    {},
  )
})

test('buildSeededDatacenterMetadata snapshots geo and server id', () => {
  const geo = { country: 'NL', city: 'Amsterdam', asn: 13335 }
  const metadata = buildSeededDatacenterMetadata(geo, SERVER_ID)
  assertEquals(metadata.geo, geo)
  assertEquals(metadata.seededFromServerId, SERVER_ID)
  if (metadata.seededAt === undefined) {
    throw new TypeError('expected seededAt timestamp')
  }
  assertEquals(Number.isNaN(Date.parse(metadata.seededAt)), false)
})
