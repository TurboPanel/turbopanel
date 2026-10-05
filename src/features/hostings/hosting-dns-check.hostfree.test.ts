import { assertEquals } from '@std/assert'
import { checkHostingDns, type DnsLookup } from './hosting-dns-check.ts'

const test = Deno.test.bind(Deno)

const NOW = new Date('2026-10-04T12:00:00.000Z')

function table(records: Record<string, string[]>): DnsLookup {
  return (name, type) => {
    const answers = records[`${name}/${type}`]
    return answers ? Promise.resolve(answers) : Promise.reject(new Error('NXDOMAIN'))
  }
}

test('names pointing at the server are ready', async () => {
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: ['203.0.113.7'],
    lookup: table({ 'a.example.com/A': ['203.0.113.7'] }),
    now: NOW,
  })
  assertEquals(report.ready, true)
  assertEquals(report.checkedAt, NOW.toISOString())
  assertEquals(report.hostnames, [
    { hostname: 'a.example.com', resolves: true, addresses: ['203.0.113.7'] },
  ])
})

test('a name pointing somewhere else, or nowhere, is not ready', async () => {
  const report = await checkHostingDns({
    hostnames: ['a.example.com', 'www.a.example.com'],
    expectedAddresses: ['203.0.113.7'],
    lookup: table({ 'a.example.com/A': ['198.51.100.1'] }),
    now: NOW,
  })
  assertEquals(report.ready, false)
  assertEquals(
    report.hostnames.map((h) => h.resolves),
    [false, false]
  )
  assertEquals(report.expectedAddresses, ['203.0.113.7'])
})

test('with no known server address any answer counts', async () => {
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: [],
    lookup: table({ 'a.example.com/AAAA': ['2001:db8::1'] }),
    now: NOW,
  })
  assertEquals(report.ready, true)
})

test('duplicate answers are listed once', async () => {
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: ['2001:db8::1'],
    lookup: table({ 'a.example.com/AAAA': ['2001:db8::1', '2001:db8::1'] }),
    now: NOW,
  })
  assertEquals(report.ready, true)
  assertEquals(report.hostnames[0]?.addresses.length, 1)
})
