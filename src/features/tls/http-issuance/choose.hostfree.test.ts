import { assert, assertEquals } from '@std/assert'
import { chooseParticipants, type ServingServer } from './choose.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function srv(id: string, over: Partial<ServingServer> = {}): ServingServer {
  return {
    serverId: id,
    label: `Server ${id}`,
    online: true,
    hasFeature: true,
    addresses: [`203.0.113.${id.charCodeAt(0) - 96}`],
    ...over,
  }
}

const DNS = ['203.0.113.1', '203.0.113.2', '203.0.113.3']

test('online servers in DNS take part: one issues, the rest help', () => {
  const choice = chooseParticipants({
    servers: [srv('c'), srv('a'), srv('b')],
    dnsAddresses: DNS,
  })
  assert(choice.ok)
  assertEquals(choice.issuer.serverId, 'a')
  assertEquals(choice.issuerAddress, '203.0.113.1')
  assertEquals(
    choice.helpers.map((h) => [h.server.serverId, h.address]),
    [
      ['b', '203.0.113.2'],
      ['c', '203.0.113.3'],
    ]
  )
  assertEquals(choice.skipped, [])
})

test('an offline server, one not in DNS and one on an old daemon are skipped with a reason', () => {
  const choice = chooseParticipants({
    servers: [
      srv('a'),
      srv('b', { online: false }),
      srv('c', { addresses: ['198.51.100.9'] }),
      srv('d', { hasFeature: false }),
    ],
    dnsAddresses: DNS,
  })
  assert(choice.ok)
  assertEquals(choice.helpers, [])
  assertEquals(
    choice.skipped.map((s) => [s.server.serverId, s.reason]),
    [
      ['b', 'offline'],
      ['c', 'not_in_dns'],
      ['d', 'old_daemon'],
    ]
  )
})

test('the previous issuing server is kept when it still qualifies', () => {
  const choice = chooseParticipants({
    servers: [srv('a'), srv('b')],
    dnsAddresses: DNS,
    previousIssuerId: 'b',
  })
  assert(choice.ok)
  assertEquals(choice.issuer.serverId, 'b')
})

test('the server that failed last time is avoided when another qualifies, but used when alone', () => {
  const two = chooseParticipants({
    servers: [srv('a'), srv('b')],
    dnsAddresses: DNS,
    previousIssuerId: 'a',
    avoidServerId: 'a',
  })
  assert(two.ok)
  assertEquals(two.issuer.serverId, 'b')
  const alone = chooseParticipants({
    servers: [srv('a')],
    dnsAddresses: DNS,
    avoidServerId: 'a',
  })
  assert(alone.ok)
  assertEquals(alone.issuer.serverId, 'a')
})

test('no server in DNS, or no serving server, waits', () => {
  const none = chooseParticipants({
    servers: [srv('a', { online: false }), srv('b', { addresses: ['198.51.100.9'] })],
    dnsAddresses: DNS,
  })
  assertEquals(none.ok, false)
  assertEquals(none.ok ? null : none.reason, 'none_in_dns')
  const empty = chooseParticipants({ servers: [], dnsAddresses: DNS })
  assertEquals(empty.ok ? null : empty.reason, 'no_servers')
})

test('with no known public address anywhere, every online server counts as in DNS', () => {
  const choice = chooseParticipants({
    servers: [srv('a', { addresses: [] }), srv('b', { addresses: [] })],
    dnsAddresses: ['203.0.113.50'],
  })
  assert(choice.ok)
  assertEquals(choice.helpers.length, 1)
  assertEquals(choice.issuerAddress, '203.0.113.50')
})

test('a server without an address is skipped when other servers do have addresses', () => {
  const choice = chooseParticipants({
    servers: [srv('a'), srv('b', { addresses: [] })],
    dnsAddresses: DNS,
  })
  assert(choice.ok)
  assertEquals(
    choice.skipped.map((s) => s.reason),
    ['not_in_dns']
  )
})
