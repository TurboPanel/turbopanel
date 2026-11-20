import { assertEquals } from '@std/assert'
import { type NameFacts, nameIsVerified } from './verified-names.ts'

const test = Deno.test.bind(Deno)
const NOW = new Date('2026-11-19T12:00:00.000Z')
const EARLIER = '2026-11-18T00:00:00.000Z'
const LATER = '2026-11-19T00:00:00.000Z'

function lePin(over: Record<string, unknown> = {}) {
  return {
    source: 'lets_encrypt',
    status: 'ready',
    notAfter: '2027-02-01T00:00:00.000Z',
    hasPair: true,
    metadata: { dnsNames: ['a.example.com'] },
    updatedAt: EARLIER,
    ...over,
  }
}

function facts(over: Partial<NameFacts> = {}): NameFacts {
  return {
    hostname: 'a.example.com',
    pin: lePin(),
    pinnedAt: EARLIER,
    deployments: [{ status: 'applied', queuedAt: LATER }],
    ...over,
  }
}

test('a name with a ready public certificate that covers it and a deploy after the pin is verified', () => {
  assertEquals(nameIsVerified(facts(), NOW), true)
})

test('a name with no pin, a self-signed pin or no deploy is not verified', () => {
  assertEquals(nameIsVerified(facts({ pin: null }), NOW), false)
  assertEquals(nameIsVerified(facts({ pin: lePin({ source: 'self_signed' }) }), NOW), false)
  assertEquals(nameIsVerified(facts({ deployments: [] }), NOW), false)
})

test('a certificate that does not cover the name, has expired or is not ready does not verify it', () => {
  assertEquals(
    nameIsVerified(facts({ pin: lePin({ metadata: { dnsNames: ['b.example.com'] } }) }), NOW),
    false
  )
  assertEquals(
    nameIsVerified(facts({ pin: lePin({ notAfter: '2026-11-01T00:00:00.000Z' }) }), NOW),
    false
  )
  assertEquals(nameIsVerified(facts({ pin: lePin({ status: 'pending' }) }), NOW), false)
  assertEquals(nameIsVerified(facts({ pin: lePin({ hasPair: false }) }), NOW), false)
})

test('a failed deploy, or one queued before the pin changed, does not verify the name', () => {
  assertEquals(
    nameIsVerified(facts({ deployments: [{ status: 'failed', queuedAt: LATER }] }), NOW),
    false
  )
  assertEquals(
    nameIsVerified(
      facts({ deployments: [{ status: 'applied', queuedAt: '2026-11-17T00:00:00.000Z' }] }),
      NOW
    ),
    false
  )
  assertEquals(
    nameIsVerified(
      facts({
        deployments: [
          { status: 'applied', queuedAt: LATER },
          { status: 'applying', queuedAt: LATER },
        ],
      }),
      NOW
    ),
    false
  )
})

function originPin(over: Record<string, unknown> = {}) {
  return {
    source: 'provider_origin',
    status: 'ready',
    notAfter: '2027-06-01T00:00:00.000Z',
    hasPair: true,
    metadata: {
      providerOrigin: {
        provider: 'cloudflare',
        carrierId: 'c1',
        badgeId: 'b1',
        zoneId: 'z1',
        zoneName: 'example.com',
        externalId: 'e1',
        hostnames: ['a.example.com'],
        scope: 'names',
      },
    },
    updatedAt: EARLIER,
    ...over,
  }
}

test('a ready origin certificate that covers the name verifies it', () => {
  assertEquals(nameIsVerified(facts({ pin: originPin() }), NOW), true)
})

test('an origin certificate that is due, unpaired, not ready or for other names does not verify', () => {
  assertEquals(
    nameIsVerified(facts({ pin: originPin({ notAfter: '2026-11-25T00:00:00.000Z' }) }), NOW),
    false
  )
  assertEquals(nameIsVerified(facts({ pin: originPin({ hasPair: false }) }), NOW), false)
  assertEquals(nameIsVerified(facts({ pin: originPin({ status: 'pending' }) }), NOW), false)
  const other = originPin()
  ;(other.metadata.providerOrigin as { hostnames: string[] }).hostnames = ['b.example.com']
  assertEquals(nameIsVerified(facts({ pin: other }), NOW), false)
})

test('a pair from the test directory never verifies a name', () => {
  const staging = lePin({ metadata: { dnsNames: ['a.example.com'], acme: { staging: true } } })
  assertEquals(nameIsVerified(facts({ pin: staging }), NOW), false)
  const ordered = {
    ...lePin({ source: 'upload' }),
    metadata: { dnsNames: ['a.example.com'], acme: { managedBy: 'panel' } },
  }
  assertEquals(nameIsVerified(facts({ pin: ordered }), NOW), true)
  const testOrdered = {
    ...ordered,
    metadata: { dnsNames: ['a.example.com'], acme: { managedBy: 'panel', staging: true } },
  }
  assertEquals(nameIsVerified(facts({ pin: testOrdered }), NOW), false)
  // An uploaded certificate nobody ordered through the authority is not public as far as the panel knows.
  assertEquals(nameIsVerified(facts({ pin: lePin({ source: 'upload' }) }), NOW), false)
})
