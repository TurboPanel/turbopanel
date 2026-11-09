import { assertEquals } from '@std/assert'
import type { DnsChallengeProvider } from '../../../../features/tls/dns-certificates/dns-provider.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import {
  caaWalk,
  denoDnsLookup,
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

test('a lookup that failed while the provider listed none is a lookup problem', async () => {
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
      "Could not look up the nameservers of example.com: the DNS provider could not list them, or this server's resolver did not answer.",
  })
})

test('a provider read that failed is a lookup problem even when the resolver lists none', async () => {
  const { provider } = fakeProvider()
  const result = await preflightDns01({
    provider: withNameservers(provider, () => Promise.reject(new Error('timed out'))),
    dns: { ...fakeDns(), ns: () => Promise.resolve([]) },
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.failure?.cause, 'dns-lookup')
})

test('a zone that both the provider and the resolver say has no nameservers is its own cause', async () => {
  const { provider } = fakeProvider()
  const result = await preflightDns01({
    provider: withNameservers(provider, () => Promise.resolve([])),
    dns: { ...fakeDns(), ns: () => Promise.resolve([]) },
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.ok, false)
  assertEquals(result.failure, {
    cause: 'no-nameservers',
    detail:
      "The example.com zone lists no nameservers: the DNS provider listed none, and this server's resolver found no NS records. Check that the zone is delegated to its DNS provider.",
  })
})

test('a provider that cannot list nameservers leaves an empty resolver answer a lookup problem', async () => {
  const { provider } = fakeProvider()
  const result = await preflightDns01({
    provider,
    dns: { ...fakeDns(), ns: () => Promise.resolve([]) },
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.failure?.cause, 'dns-lookup')
})

test('nameserver names with no address fail as a lookup problem and name them', async () => {
  const { provider } = fakeProvider()
  const result = await preflightDns01({
    provider: withNameservers(provider, () => Promise.resolve(['ns1.example.net'])),
    dns: { ...fakeDns(), addresses: () => Promise.reject(new Error('lookup timed out')) },
    zones: ZONES,
    host: 'panel.example.com',
  })
  assertEquals(result.failure, {
    cause: 'dns-lookup',
    detail:
      "Could not look up the addresses of the example.com nameservers (ns1.example.net) through this server's resolver.",
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

type Resolve = (name: string, type: string, options?: Deno.ResolveDnsOptions) => Promise<unknown>

/** Swap `Deno.resolveDns` while `fn` runs, so no real lookup leaves this host. */
async function withResolveDns(resolve: Resolve, fn: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(Deno, 'resolveDns')
  Object.defineProperty(Deno, 'resolveDns', { value: resolve, configurable: true, writable: true })
  try {
    await fn()
  } finally {
    if (original) Object.defineProperty(Deno, 'resolveDns', original)
  }
}

test("the real lookups ask only this host's resolver, with a timeout", async () => {
  const asked: string[] = []
  const answers: Record<string, string[]> = {
    'NS example.com': ['ns1.example.net.'],
    'A ns1.example.net': ['192.0.2.53'],
  }
  await withResolveDns(
    (name, type, options) => {
      asked.push(`${type} ${name} ${options?.nameServer ? 'other' : 'system'}`)
      assertEquals(options?.signal instanceof AbortSignal, true)
      const answer = answers[`${type} ${name}`]
      return answer ? Promise.resolve(answer) : Promise.reject(new Error('no records'))
    },
    async () => {
      assertEquals(await denoDnsLookup.ns('example.com'), ['ns1.example.net.'])
      assertEquals(await denoDnsLookup.addresses('ns1.example.net'), ['192.0.2.53'])
      assertEquals(await denoDnsLookup.addresses('ns2.example.net'), [])
    }
  )
  assertEquals(asked, [
    'NS example.com system',
    'A ns1.example.net system',
    'AAAA ns1.example.net system',
    'A ns2.example.net system',
    'AAAA ns2.example.net system',
  ])
})
