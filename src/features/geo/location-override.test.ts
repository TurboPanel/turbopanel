import { assertEquals } from '@std/assert'
import {
  applyLocationPatch,
  datacenterDetectedGeo,
  MAX_ASN,
  parseLocationOverride,
  parseLocationPatchInput,
  resolveLocation,
} from './location-override.ts'
import type { ServerGeo } from './server-geo.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const DETECTED: ServerGeo = {
  city: 'Austin',
  region: 'Texas',
  regionCode: 'TX',
  country: 'US',
  asn: 13335,
  asOrganization: 'Cloudflare, Inc.',
  datacenter: 'DFW',
  capturedAt: '2026-09-26T00:00:00.000Z',
}

test('resolveLocation: no override → every field detected, source detected', () => {
  const location = resolveLocation({ timezone: 'UTC' }, DETECTED)
  assertEquals(location, {
    city: 'Austin',
    region: 'Texas',
    regionCode: 'TX',
    country: 'US',
    asn: 13335,
    asOrganization: 'Cloudflare, Inc.',
    source: 'detected',
    overridden: [],
    detected: {
      city: 'Austin',
      region: 'Texas',
      regionCode: 'TX',
      country: 'US',
      asn: 13335,
      asOrganization: 'Cloudflare, Inc.',
    },
  })
})

test('resolveLocation: an override wins per field and keeps the detected values', () => {
  const location = resolveLocation(
    { location: { city: 'Round Rock', asn: 64512, asOrganization: 'Home lab' } },
    DETECTED
  )
  assertEquals(location.city, 'Round Rock')
  assertEquals(location.region, 'Texas')
  assertEquals(location.asn, 64512)
  assertEquals(location.asOrganization, 'Home lab')
  assertEquals(location.source, 'custom')
  assertEquals(location.overridden, ['city', 'asn', 'asOrganization'])
  assertEquals(location.detected.city, 'Austin')
  assertEquals(location.detected.asn, 13335)
})

test('resolveLocation: no geo and no override → all null', () => {
  const location = resolveLocation(null, null)
  assertEquals(location.city, null)
  assertEquals(location.country, null)
  assertEquals(location.asn, null)
  assertEquals(location.source, 'detected')
})

test('resolveLocation: override alone works without any detected geo', () => {
  const location = resolveLocation({ location: { country: 'de', city: 'Berlin' } }, undefined)
  assertEquals(location.city, 'Berlin')
  assertEquals(location.country, 'DE')
  assertEquals(location.detected.country, null)
})

test('datacenterDetectedGeo reads the seeded metadata.geo', () => {
  assertEquals(datacenterDetectedGeo({ geo: { city: 'Austin', asn: 7018 } })?.city, 'Austin')
  assertEquals(datacenterDetectedGeo({ seededFromServerId: 'x' }), null)
  assertEquals(datacenterDetectedGeo(null), null)
})

test('parseLocationOverride drops invalid and unknown stored keys', () => {
  assertEquals(
    parseLocationOverride({
      city: '  Austin ',
      country: 'USA',
      asn: -1,
      region: '',
      junk: 'x',
    }),
    { city: 'Austin' }
  )
  assertEquals(parseLocationOverride({ country: 'x' }), undefined)
  assertEquals(parseLocationOverride('nope'), undefined)
})

test('parseLocationPatchInput: null resets everything', () => {
  assertEquals(parseLocationPatchInput(null), { ok: true, value: null })
})

test('parseLocationPatchInput: sets, clears and normalises fields', () => {
  assertEquals(
    parseLocationPatchInput({
      city: ' Austin ',
      country: 'us',
      asn: 'AS13335',
      region: null,
      regionCode: '',
    }),
    {
      ok: true,
      value: { city: 'Austin', country: 'US', asn: 13335, region: null, regionCode: null },
    }
  )
})

test('parseLocationPatchInput refuses unknown fields, bad values and empty objects', () => {
  assertEquals(parseLocationPatchInput({ datacenter: 'DFW' }).ok, false)
  assertEquals(parseLocationPatchInput({ country: 'USA' }).ok, false)
  assertEquals(parseLocationPatchInput({ asn: 0 }).ok, false)
  assertEquals(parseLocationPatchInput({ asn: 1.5 }).ok, false)
  assertEquals(parseLocationPatchInput({ asn: MAX_ASN + 1 }).ok, false)
  assertEquals(parseLocationPatchInput({ city: 'x'.repeat(129) }).ok, false)
  assertEquals(parseLocationPatchInput({ city: 42 }).ok, false)
  assertEquals(parseLocationPatchInput({}).ok, false)
  assertEquals(parseLocationPatchInput('Austin').ok, false)
  assertEquals(parseLocationPatchInput([]).ok, false)
})

test('applyLocationPatch merges, clears fields, and resets', () => {
  const previous = { city: 'Austin', asn: 64512 }
  assertEquals(applyLocationPatch(previous, { country: 'US' }), {
    city: 'Austin',
    asn: 64512,
    country: 'US',
  })
  assertEquals(applyLocationPatch(previous, { city: null }), { asn: 64512 })
  assertEquals(applyLocationPatch(previous, { city: null, asn: null }), null)
  assertEquals(applyLocationPatch(previous, null), null)
  assertEquals(applyLocationPatch(undefined, { city: 'Berlin' }), { city: 'Berlin' })
})
