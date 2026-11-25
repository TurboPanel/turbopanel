/**
 * The DNS proof path of a server-placed order, without a database: who may
 * issue, the silence limits of a DNS request, the organization caps, and the
 * rule that an order over DNS is never sent to a daemon that does not list
 * `acme-issue-dns-v1` (it would drop the field and run the HTTP proof).
 */
import { assert, assertEquals } from '@std/assert'
import type { DaemonOutboundEnvelope } from '../../../contracts/cell-protocol.ts'
import { ACME_ISSUE_DNS_FEATURE } from '../../../lib/version-wire.ts'
import { type OrgOrderFacts, mayStartNewCertificate, NEW_CERTIFICATES_PER_DAY } from './caps.ts'
import { chooseDnsIssuer, type ServingServer } from './choose.ts'
import { type HttpIssuanceDeps, sendAll } from './orchestrator.ts'
import { DNS_DEADLINE_GRACE_MS, DNS_ORDER_DEADLINE_MS, decideOpen } from './progress.ts'
import { newHttpIssuanceState } from './state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const T0 = new Date('2026-11-01T12:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

function srv(id: string, over: Partial<ServingServer> = {}): ServingServer {
  return {
    serverId: id,
    label: `Server ${id}`,
    online: true,
    addresses: [],
    takesDnsOrders: true,
    ...over,
  }
}

test('any online server that takes DNS orders may issue, with no address check', () => {
  const choice = chooseDnsIssuer({ servers: [srv('c'), srv('a'), srv('b')] })
  assert(choice.ok)
  assertEquals(choice.issuer.serverId, 'a')
})

test('an offline server and one without the feature are skipped, never chosen', () => {
  const choice = chooseDnsIssuer({
    servers: [srv('a', { online: false }), srv('b', { takesDnsOrders: false }), srv('c')],
  })
  assert(choice.ok)
  assertEquals(choice.issuer.serverId, 'c')
  assertEquals(
    choice.skipped.map((s) => [s.server.serverId, s.reason]),
    [
      ['a', 'offline'],
      ['b', 'no_dns_orders'],
    ]
  )
})

test('with no server able to take a DNS order the request waits', () => {
  const none = chooseDnsIssuer({
    servers: [srv('a', { takesDnsOrders: false }), srv('b', { online: false })],
  })
  assert(!none.ok)
  assertEquals(none.reason, 'none_take_dns')
  const empty = chooseDnsIssuer({ servers: [] })
  assert(!empty.ok)
  assertEquals(empty.reason, 'no_servers')
})

test('the previous issuer is kept and the one that just failed is avoided', () => {
  const servers = [srv('a'), srv('b'), srv('c')]
  const kept = chooseDnsIssuer({ servers, previousIssuerId: 'b' })
  assert(kept.ok)
  assertEquals(kept.issuer.serverId, 'b')
  const avoided = chooseDnsIssuer({ servers, avoidServerId: 'a' })
  assert(avoided.ok)
  assertEquals(avoided.issuer.serverId, 'b')
})

function dnsOpen(sentAt: Date | null) {
  return newHttpIssuanceState({
    issuingServerId: 'a',
    requestId: 'req_1',
    startedAt: T0.toISOString(),
    startByAt: at(15 * 60_000).toISOString(),
    challenge: 'dns-01',
    phase: 'ordering',
    orderSentAt: sentAt?.toISOString() ?? null,
    lastEventAt: sentAt?.toISOString() ?? null,
  })
}

test('a DNS order is given up after the daemon deadline plus a minute, not at the HTTP silence limit', () => {
  const state = dnsOpen(T0)
  // Past the HTTP silence limit for a first event, but a DNS order may still be inside its deadline.
  assertEquals(decideOpen(state, at(DNS_ORDER_DEADLINE_MS - 1_000)), { kind: 'wait' })
  const late = decideOpen(state, at(DNS_ORDER_DEADLINE_MS + DNS_DEADLINE_GRACE_MS))
  assertEquals(late.kind, 'fail')
})

function facts(over: Partial<OrgOrderFacts> = {}): OrgOrderFacts {
  return { newStarts: [], waiting: [], ...over }
}

test('an organization may start ten new certificates a day, not eleven', () => {
  const starts = (n: number, ago: number) =>
    Array.from({ length: n }, () => new Date(T0.getTime() - ago).toISOString())
  assertEquals(
    mayStartNewCertificate(facts({ newStarts: starts(NEW_CERTIFICATES_PER_DAY - 1, 60_000) }), T0),
    { ok: true }
  )
  assertEquals(
    mayStartNewCertificate(facts({ newStarts: starts(NEW_CERTIFICATES_PER_DAY, 60_000) }), T0),
    {
      ok: false,
      reason: 'daily_cap',
    }
  )
  // Starts older than a day no longer count.
  assertEquals(
    mayStartNewCertificate(
      facts({ newStarts: starts(NEW_CERTIFICATES_PER_DAY, 25 * 3_600_000) }),
      T0
    ),
    { ok: true }
  )
})

test('a rate limit from the authority pauses every new start until it passes', () => {
  const waiting = [
    {
      nextAttemptAt: at(3_600_000).toISOString(),
      reason: 'The authority is rate limiting this account.',
    },
  ]
  const verdict = mayStartNewCertificate(facts({ waiting }), T0)
  // Only a reason recognised as a rate limit pauses; an ordinary failure does not.
  const ordinary = mayStartNewCertificate(
    facts({
      waiting: [
        {
          nextAttemptAt: at(3_600_000).toISOString(),
          reason: 'The server did not answer the order.',
        },
      ],
    }),
    T0
  )
  assertEquals(ordinary, { ok: true })
  assertEquals(verdict, { ok: false, reason: 'rate_limited' })
  // Once the wait has passed the pause is over.
  assertEquals(mayStartNewCertificate(facts({ waiting }), at(2 * 3_600_000)), { ok: true })
})

function deps(features: readonly string[], sent: string[]): HttpIssuanceDeps {
  return {
    send: (serverId: string) => {
      sent.push(serverId)
      return Promise.resolve()
    },
    serverFeatures: () => Promise.resolve(features),
  } as unknown as HttpIssuanceDeps
}

function request(challenge: 'dns-01' | 'http-01' | undefined): DaemonOutboundEnvelope {
  return {
    kind: 'acme-issue-request',
    acmeRequestId: 'req_1',
    tlsId: 't1',
    names: ['example.com'],
    directory: 'staging',
    contactEmail: 'ops@example.com',
    ...(challenge ? { challenge } : {}),
    startByIso: at(60_000).toISOString(),
    helpers: [],
  } as unknown as DaemonOutboundEnvelope
}

test('PIN: dns-01 is never sent to a daemon without acme-issue-dns-v1', async () => {
  const sent: string[] = []
  const failed = await sendAll(deps(['acme-issue-v1'], sent), [
    { serverId: 'old', envelope: request('dns-01') },
  ])
  assertEquals(sent, [])
  assertEquals(failed, ['old'])
  // A server whose feature read throws is treated as an old daemon.
  const throwing = { ...deps([], sent), serverFeatures: () => Promise.reject(new Error('down')) }
  assertEquals(await sendAll(throwing, [{ serverId: 'x', envelope: request('dns-01') }]), ['x'])
  assertEquals(sent, [])
})

test('dns-01 goes to a daemon that lists the feature, and an HTTP order is unaffected', async () => {
  const sent: string[] = []
  assertEquals(
    await sendAll(deps([ACME_ISSUE_DNS_FEATURE], sent), [
      { serverId: 'new', envelope: request('dns-01') },
    ]),
    []
  )
  assertEquals(
    await sendAll(deps([], sent), [{ serverId: 'old', envelope: request(undefined) }]),
    []
  )
  assertEquals(sent, ['new', 'old'])
})
