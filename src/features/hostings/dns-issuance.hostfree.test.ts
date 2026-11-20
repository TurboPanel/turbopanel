/**
 * The DNS ordering gate for one name, without a database: each precondition on
 * its own, and the order the reasons are given in.
 */
import { assertEquals } from '@std/assert'
import type { BadgeRow } from '../tunnels/records.ts'
import { type DnsIssuanceInputs, dnsIssuanceFor } from './dns-issuance.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

function token(over: Partial<Pick<BadgeRow, 'status' | 'capabilities'>> = {}): BadgeRow {
  return {
    status: 'active',
    capabilities: { tunnels: false, dns: [{ id: 'z1', name: 'example.net' }], certificates: [] },
    ...over,
  } as unknown as BadgeRow
}

function inputs(over: Partial<DnsIssuanceInputs> = {}): DnsIssuanceInputs {
  return {
    acmeEnabled: true,
    badges: [token()],
    servers: { capable: 1 },
    ...over,
  }
}

test('a name with Lets Encrypt on, a covering token and a capable server is offered', () => {
  assertEquals(dnsIssuanceFor('app.example.net', inputs()), { dnsIssuance: true })
})

test('the zone itself and its subdomains are covered', () => {
  assertEquals(dnsIssuanceFor('example.net', inputs()).dnsIssuance, true)
  assertEquals(dnsIssuanceFor('a.b.example.net', inputs()).dnsIssuance, true)
})

test('Lets Encrypt turned off says so first', () => {
  assertEquals(dnsIssuanceFor('app.example.net', inputs({ acmeEnabled: false })), {
    dnsIssuance: false,
    dnsUnavailableReason: "Let's Encrypt is not turned on for this organization",
  })
})

test('no token for the name names the name', () => {
  assertEquals(dnsIssuanceFor('app.example.org', inputs()), {
    dnsIssuance: false,
    dnsUnavailableReason: 'No DNS token covers app.example.org',
  })
  assertEquals(dnsIssuanceFor('app.example.net', inputs({ badges: [] })).dnsIssuance, false)
})

test('a name that only ends like the zone is not covered', () => {
  assertEquals(dnsIssuanceFor('notexample.net', inputs()).dnsIssuance, false)
})

test('a token that is not active covers nothing', () => {
  const badges = [token({ status: 'attention' })]
  assertEquals(dnsIssuanceFor('app.example.net', inputs({ badges })).dnsIssuance, false)
})

test('a token with no DNS zones covers nothing', () => {
  const badges = [token({ capabilities: { tunnels: true, dns: [], certificates: [] } })]
  assertEquals(dnsIssuanceFor('app.example.net', inputs({ badges })).dnsIssuance, false)
})

test('no serving server that lists the feature says so', () => {
  const expected = {
    dnsIssuance: false,
    dnsUnavailableReason: 'No server serving this name can order over DNS yet',
  }
  assertEquals(dnsIssuanceFor('app.example.net', inputs({ servers: { capable: 0 } })), expected)
  // A token that does not cover the name is told first, whatever the servers can do.
  assertEquals(dnsIssuanceFor('app.example.org', inputs({ servers: { capable: 0 } })), {
    dnsIssuance: false,
    dnsUnavailableReason: 'No DNS token covers app.example.org',
  })
})
