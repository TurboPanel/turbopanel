import { assertEquals } from '@std/assert'
import type { DnsChallengeProvider } from '../../../../features/tls/dns-certificates/dns-provider.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import {
  caaWalk,
  type DnsLookup,
  preflightDns01,
  txtNotVisibleDetail,
  txtVisibleOnAll,
} from './preflight.ts'

const test = Deno.test.bind(Deno)

const ZONES = [{ id: 'zone-1', name: 'example.com' }]

function fakeDns(caa: Record<string, { tag: string; value: string }[]> = {}): DnsLookup {
  return {
    caa: (name) => Promise.resolve(caa[name] ?? []),
    ns: () => Promise.resolve(['ns1.example.net.', 'ns2.example.net.']),
    addresses: (name) =>
      Promise.resolve(name === 'ns1.example.net' ? ['192.0.2.53'] : ['198.51.100.53']),
    txtAt: (_name, server) => Promise.resolve(server === '192.0.2.53' ? ['token-value'] : []),
  }
}

function fakeProvider(refuse = false): { provider: DnsChallengeProvider; removed: string[] } {
  const removed: string[] = []
  const provider: DnsChallengeProvider = {
    lookupCname: () => Promise.resolve(null),
    present: () =>
      refuse
        ? Promise.reject(new TunnelProviderError('forbidden', 'refused', 403))
        : Promise.resolve({ zoneId: 'zone-1', recordId: 'probe-1' }),
    remove: (ref) => {
      removed.push(ref.recordId)
      return Promise.resolve()
    },
  }
  return { provider, removed }
}

test('a name outside every zone fails before any write', async () => {
  const { provider } = fakeProvider()
  const result = await preflightDns01({
    provider,
    dns: fakeDns(),
    zones: ZONES,
    host: 'panel.other.org',
  })
  assertEquals(result.failure?.cause, 'zone-not-on-provider')
})

test('a token that cannot write TXT records is scope-missing', async () => {
  const { provider } = fakeProvider(true)
  const result = await preflightDns01({
    provider,
    dns: fakeDns(),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.failure?.cause, 'scope-missing')
})

test('a CAA record on a parent naming another issuer forbids the order, and the probe record is gone', async () => {
  const { provider, removed } = fakeProvider()
  const dns = fakeDns({ 'example.com': [{ tag: 'issue', value: 'digicert.com' }] })
  const result = await preflightDns01({ provider, dns, zones: ZONES, host: 'panel.example.com' })
  assertEquals(result.failure?.cause, 'caa-forbids')
  assertEquals(removed, ['probe-1'])
})

test("CAA on the apex allowing Let's Encrypt passes and the nameservers are resolved", async () => {
  const { provider } = fakeProvider()
  const dns = fakeDns({
    'example.com': [{ tag: 'issue', value: 'letsencrypt.org; validationmethods=dns-01' }],
  })
  const result = await preflightDns01({ provider, dns, zones: ZONES, host: 'panel.example.com' })
  assertEquals(result.ok, true)
  assertEquals(result.nameservers, ['192.0.2.53', '198.51.100.53'])
})

/** A resolver behind split DNS: the zone is answered locally, so it has no NS records. */
function splitDns(): DnsLookup {
  return {
    ...fakeDns(),
    ns: () => Promise.reject(new Error('no records found for NS query')),
  }
}

function withNameservers(
  provider: DnsChallengeProvider,
  nameservers: DnsChallengeProvider['nameservers']
): DnsChallengeProvider {
  return { ...provider, nameservers }
}

test("the provider's nameservers are used when this host's resolver lists none", async () => {
  const { provider } = fakeProvider()
  const listed = withNameservers(provider, (zoneId) =>
    Promise.resolve(zoneId === 'zone-1' ? ['ns1.example.net', 'ns2.example.net'] : [])
  )
  const result = await preflightDns01({
    provider: listed,
    dns: splitDns(),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.ok, true)
  assertEquals(result.nameservers, ['192.0.2.53', '198.51.100.53'])
})

test("the provider's nameservers win over the resolver's", async () => {
  const { provider } = fakeProvider()
  const listed = withNameservers(provider, () => Promise.resolve(['ns1.example.net']))
  const result = await preflightDns01({
    provider: listed,
    dns: fakeDns(),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.nameservers, ['192.0.2.53'])
})

test('a provider that refuses the nameserver read falls back to the resolver', async () => {
  const { provider } = fakeProvider()
  const refusing = withNameservers(provider, () =>
    Promise.reject(new TunnelProviderError('forbidden', 'refused', 403))
  )
  const result = await preflightDns01({
    provider: refusing,
    dns: fakeDns(),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.ok, true)
  assertEquals(result.nameservers, ['192.0.2.53', '198.51.100.53'])
})

test('no nameservers from the provider or the resolver fails and says where it looked', async () => {
  const { provider } = fakeProvider()
  const result = await preflightDns01({
    provider: withNameservers(provider, () => Promise.resolve([])),
    dns: splitDns(),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.ok, false)
  assertEquals(result.failure, {
    cause: 'dns-lookup',
    detail:
      "No nameservers found for example.com: the DNS provider listed none, and neither this server's resolver nor the public resolvers returned NS records.",
  })
})

/** Records which resolver each lookup asked (`system` for this host's own). */
function answeringOnly(answering: string, asked: string[]): DnsLookup {
  return {
    ...fakeDns(),
    ns: (name, resolver) => {
      asked.push(`ns ${name} ${resolver ?? 'system'}`)
      return resolver === answering
        ? Promise.resolve(['ns1.example.net.'])
        : Promise.reject(new Error('lookup timed out'))
    },
    addresses: (name, resolver) => {
      asked.push(`a ${name} ${resolver ?? 'system'}`)
      return Promise.resolve(resolver === answering ? ['192.0.2.53'] : [])
    },
  }
}

test("nameserver addresses this host's resolver cannot find are asked of a public resolver", async () => {
  const { provider } = fakeProvider()
  const asked: string[] = []
  const result = await preflightDns01({
    provider: withNameservers(provider, () => Promise.resolve(['ns1.example.net'])),
    dns: answeringOnly('1.1.1.1', asked),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.ok, true)
  assertEquals(result.nameservers, ['192.0.2.53'])
  assertEquals(asked, ['a ns1.example.net system', 'a ns1.example.net 1.1.1.1'])
})

test('with no provider list, a failed NS lookup moves on through the public resolvers', async () => {
  const { provider } = fakeProvider()
  const asked: string[] = []
  const result = await preflightDns01({
    provider,
    dns: answeringOnly('8.8.8.8', asked),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.ok, true)
  assertEquals(result.nameservers, ['192.0.2.53'])
  assertEquals(asked.slice(0, 3), [
    'ns example.com system',
    'ns example.com 1.1.1.1',
    'ns example.com 8.8.8.8',
  ])
})

test('nameserver names with no address anywhere fail as a lookup problem and name them', async () => {
  const { provider } = fakeProvider()
  const result = await preflightDns01({
    provider: withNameservers(provider, () => Promise.resolve(['ns1.example.net'])),
    dns: answeringOnly('192.0.2.1', []),
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.failure, {
    cause: 'dns-lookup',
    detail:
      "Could not look up the addresses of the example.com nameservers (ns1.example.net) through this server's resolver or the public resolvers.",
  })
})

test('txtVisibleOnAll names the servers that do not answer yet', async () => {
  const seen = await txtVisibleOnAll(
    fakeDns(),
    ['192.0.2.53', '198.51.100.53'],
    '_acme-challenge.x',
    'token-value'
  )
  assertEquals(seen, {
    ok: false,
    confirmed: ['192.0.2.53'],
    missing: ['198.51.100.53'],
    unreachable: [],
  })
  assertEquals(
    txtNotVisibleDetail(seen),
    'The challenge record is not visible on 1 of 2 authoritative nameservers that answered yet.'
  )
})

/** A zone listed on IPv4 and IPv6 addresses, seen from a host with no IPv6 route. */
function ipv4OnlyDns(answers: Record<string, string[]>): DnsLookup {
  return {
    ...fakeDns(),
    txtAt: (_name, server) =>
      server.includes(':')
        ? Promise.reject(new Error('io error: Network is unreachable (os error 101)'))
        : Promise.resolve(answers[server] ?? []),
  }
}

const MIXED_SERVERS = ['192.0.2.53', '198.51.100.53', '2001:db8::53', '2001:db8::54']

test('txtVisibleOnAll passes when every server that answers has the value and the rest are unreachable', async () => {
  const seen = await txtVisibleOnAll(
    ipv4OnlyDns({ '192.0.2.53': ['token-value'], '198.51.100.53': ['token-value'] }),
    MIXED_SERVERS,
    '_acme-challenge.x',
    'token-value'
  )
  assertEquals(seen, {
    ok: true,
    confirmed: ['192.0.2.53', '198.51.100.53'],
    missing: [],
    unreachable: ['2001:db8::53', '2001:db8::54'],
  })
})

test('txtVisibleOnAll still waits on a reachable server that answers without the value', async () => {
  const seen = await txtVisibleOnAll(
    ipv4OnlyDns({ '192.0.2.53': ['token-value'], '198.51.100.53': ['older-value'] }),
    MIXED_SERVERS,
    '_acme-challenge.x',
    'token-value'
  )
  assertEquals(seen.ok, false)
  assertEquals(seen.missing, ['198.51.100.53'])
  assertEquals(
    txtNotVisibleDetail(seen),
    'The challenge record is not visible on 1 of 2 authoritative nameservers that answered yet.'
  )
})

test('txtVisibleOnAll fails when no server can be reached at all', async () => {
  const seen = await txtVisibleOnAll(
    ipv4OnlyDns({}),
    ['2001:db8::53', '2001:db8::54'],
    '_acme-challenge.x',
    'token-value'
  )
  assertEquals(seen, {
    ok: false,
    confirmed: [],
    missing: [],
    unreachable: ['2001:db8::53', '2001:db8::54'],
  })
  assertEquals(
    txtNotVisibleDetail(seen),
    'No authoritative nameserver could be reached to check the challenge record (2 tried).'
  )
})

test('caaWalk goes from the name up to the zone apex', () => {
  assertEquals(caaWalk('a.b.example.com', 'example.com'), [
    'a.b.example.com',
    'b.example.com',
    'example.com',
  ])
})
