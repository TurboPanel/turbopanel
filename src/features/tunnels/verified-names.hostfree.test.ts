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
