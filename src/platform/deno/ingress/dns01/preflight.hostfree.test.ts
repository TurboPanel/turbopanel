import { assertEquals } from '@std/assert'
import type { DnsChallengeProvider } from '../../../../features/tls/dns-certificates/dns-provider.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import { caaWalk, type DnsLookup, preflightDns01, txtVisibleOnAll } from './preflight.ts'

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

test('txtVisibleOnAll names the servers that do not answer yet', async () => {
  const seen = await txtVisibleOnAll(
    fakeDns(),
    ['192.0.2.53', '198.51.100.53'],
    '_acme-challenge.x',
    'token-value'
  )
  assertEquals(seen, { ok: false, missing: ['198.51.100.53'] })
})

test('caaWalk goes from the name up to the zone apex', () => {
  assertEquals(caaWalk('a.b.example.com', 'example.com'), [
    'a.b.example.com',
    'b.example.com',
    'example.com',
  ])
})
