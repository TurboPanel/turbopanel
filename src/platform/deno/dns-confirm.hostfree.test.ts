import { assertEquals } from '@std/assert'
import type { DnsChallengeProvider } from '../../features/tls/dns-certificates/dns-provider.ts'
import { confirmOnNameserversWith } from './dns-confirm.ts'
import type { DnsLookup } from './ingress/dns01/preflight.ts'

/** Sonar typescript:S2187 only recognizes `test()`; see the other host-free suites. */
const test = Deno.test.bind(Deno)

const NAME = '_acme-challenge.tptest.example.net'
const ADDRESSES: Record<string, string[]> = {
  'ns1.example.net': ['192.0.2.1', '2001:db8::1'],
  'ns2.example.net': ['192.0.2.2'],
}

function fixture(txt: Record<string, string[]>) {
  const asked: string[] = []
  const lookup: DnsLookup = {
    caa: () => Promise.resolve([]),
    ns: () => Promise.resolve([]),
    addresses: (name) => Promise.resolve(ADDRESSES[name] ?? []),
    txtAt: (_name, server) => {
      asked.push(server)
      // Like the real resolver: only an address can be asked, a host name is an error.
      if (!/^[\d.:a-f]+$/i.test(server)) return Promise.reject(new Error('not an address'))
      return Promise.resolve(txt[server] ?? [])
    },
  }
  const dns = {
    nameservers: () => Promise.resolve(['ns1.example.net.', 'ns2.example.net']),
  } as unknown as DnsChallengeProvider
  return { asked, confirm: confirmOnNameserversWith(lookup), dns }
}

const input = (dns: DnsChallengeProvider) => ({ dns, zoneId: 'z', name: NAME, value: 'v1' })

test('asks the nameservers by address and confirms when they hold the value', async () => {
  const f = fixture({ '192.0.2.1': ['v1'], '2001:db8::1': ['v1'], '192.0.2.2': ['other', 'v1'] })
  assertEquals(await f.confirm(input(f.dns)), true)
  assertEquals(f.asked.sort(), ['192.0.2.1', '192.0.2.2', '2001:db8::1'])
})

test('waits while one nameserver lacks the value', async () => {
  const f = fixture({ '192.0.2.1': ['v1'], '2001:db8::1': ['v1'], '192.0.2.2': [] })
  assertEquals(await f.confirm(input(f.dns)), false)
})

test('keeps waiting when no nameserver address resolves', async () => {
  const f = fixture({})
  const lookup = { ...ADDRESSES }
  for (const key of Object.keys(lookup)) delete ADDRESSES[key]
  try {
    assertEquals(await f.confirm(input(f.dns)), false)
    assertEquals(f.asked, [])
  } finally {
    Object.assign(ADDRESSES, lookup)
  }
})
