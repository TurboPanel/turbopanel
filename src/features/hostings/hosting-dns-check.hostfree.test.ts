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

test('with no known server address any answer counts, and the result says it was not compared', async () => {
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: [],
    lookup: table({ 'a.example.com/AAAA': ['2001:db8::1'] }),
    now: NOW,
  })
  assertEquals(report.ready, true)
  assertEquals(report.expectedAddresses, [])
  assertEquals(
    report.hostnames[0]?.warning,
    "The panel knows no public address for this site's server, so it could not check that a.example.com points at it. Make sure it does before Let's Encrypt checks it."
  )
})

test('a wrong AAAA is caught against reported addresses: alone it blocks, beside a right one it warns', async () => {
  // A server with no managed addresses, checked against what its daemon reports.
  const reported = ['45.32.200.170', '2001:db8:10::1', '2001:db8:10::2']
  const alone = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: reported,
    lookup: table({
      'a.example.com/A': ['45.32.200.170'],
      'a.example.com/AAAA': ['2001:db8:99::1'],
    }),
    now: NOW,
  })
  assertEquals(alone.ready, false)
  assertEquals(alone.hostnames[0]?.wrongAddresses, ['2001:db8:99::1'])
  assertEquals(alone.hostnames[0]?.problem?.includes('tries IPv6 first'), true)
  const beside = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: reported,
    lookup: table({
      'a.example.com/A': ['45.32.200.170'],
      'a.example.com/AAAA': ['2001:db8:10::2', '2001:db8:99::1'],
    }),
    now: NOW,
  })
  assertEquals(beside.ready, true)
  assertEquals(beside.hostnames[0]?.warning?.includes('2001:db8:99::1'), true)
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

test('every answer must be a serving server: a stale AAAA beside a right A is not ready', async () => {
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: ['198.51.100.7', '198.51.100.8'],
    lookup: table({
      'a.example.com/A': ['198.51.100.7', '198.51.100.8'],
      'a.example.com/AAAA': ['2001:db8::99'],
    }),
    now: NOW,
  })
  assertEquals(report.ready, false)
  const entry = report.hostnames[0]!
  assertEquals(entry.resolves, false)
  assertEquals(entry.wrongAddresses, ['2001:db8::99'])
  assertEquals(entry.problem?.includes('tries IPv6 first'), true)
})

test('round-robin across the serving servers is ready', async () => {
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: ['198.51.100.7', '198.51.100.8'],
    lookup: table({ 'a.example.com/A': ['198.51.100.7', '198.51.100.8'] }),
    now: NOW,
  })
  assertEquals(report.ready, true)
})

test('a name behind a NAT address with port 80 not forwarded says so plainly', async () => {
  const report = await checkHostingDns({
    hostnames: ['w.example.com'],
    expectedAddresses: [],
    lookup: table({ 'w.example.com/A': ['198.203.204.120'] }),
    now: NOW,
    probes: {
      port80: () =>
        Promise.resolve({ state: 'closed' as const, error: 'Connection refused (os error 111)' }),
    },
  })
  assertEquals(report.ready, false)
  const entry = report.hostnames[0]!
  assertEquals(entry.port80, 'closed')
  assertEquals(
    entry.problem?.startsWith(
      'w.example.com points at 198.203.204.120, but port 80 there refused the connection'
    ),
    true
  )
})

test('a private answer is named and port 80 is never probed for it', async () => {
  let probed = false
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: [],
    lookup: table({ 'a.example.com/A': ['10.0.0.5'] }),
    now: NOW,
    probes: {
      port80: () => {
        probed = true
        return Promise.resolve({ state: 'open' as const })
      },
    },
  })
  assertEquals(report.ready, false)
  assertEquals(probed, false)
  assertEquals(report.hostnames[0]!.problem?.includes('cannot reach'), true)
})

test('0.0.0.0, multicast and broadcast answers are refused and never probed', async () => {
  for (const address of ['0.0.0.0', '224.0.0.1', '255.255.255.255']) {
    let probed = false
    const report = await checkHostingDns({
      hostnames: ['a.example.com'],
      expectedAddresses: [],
      lookup: table({ 'a.example.com/A': [address] }),
      now: NOW,
      probes: {
        port80: () => {
          probed = true
          return Promise.resolve({ state: 'open' as const })
        },
      },
    })
    assertEquals(report.ready, false, address)
    assertEquals(probed, false, address)
  }
})

test('the port-80 probe gets the exact addresses the check judged, and unknown never blocks', async () => {
  const seen: string[][] = []
  const report = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: [],
    lookup: table({ 'a.example.com/A': ['198.51.100.7'], 'a.example.com/AAAA': ['2001:db8::7'] }),
    now: NOW,
    probes: {
      port80: (_name, addresses) => {
        seen.push([...addresses])
        return Promise.resolve({ state: 'unknown' as const, error: 'timed out' })
      },
    },
  })
  assertEquals(seen, [['198.51.100.7', '2001:db8::7']])
  assertEquals(report.ready, true)
  assertEquals(report.hostnames[0]!.port80, undefined)
})

test('a wrong answer beside a right one in the same family warns; an all-wrong family blocks', async () => {
  const warns = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: ['198.51.100.7'],
    lookup: table({ 'a.example.com/A': ['198.51.100.7', '198.51.100.99'] }),
    now: NOW,
  })
  assertEquals(warns.ready, true)
  assertEquals(warns.hostnames[0]!.wrongAddresses, ['198.51.100.99'])
  assertEquals(typeof warns.hostnames[0]!.warning, 'string')
  // The server has no IPv6, so any AAAA record is wrong and blocks.
  const blocks = await checkHostingDns({
    hostnames: ['a.example.com'],
    expectedAddresses: ['198.51.100.7'],
    lookup: table({ 'a.example.com/A': ['198.51.100.7'], 'a.example.com/AAAA': ['2001:db8::99'] }),
    now: NOW,
  })
  assertEquals(blocks.ready, false)
})

test('a CAA record that names another authority blocks; one that names Let’s Encrypt passes', async () => {
  const blocked = await checkHostingDns({
    hostnames: ['shop.example.com'],
    expectedAddresses: ['198.51.100.7'],
    lookup: table({ 'shop.example.com/A': ['198.51.100.7'] }),
    now: NOW,
    probes: {
      port80: () => Promise.resolve({ state: 'open' as const }),
      caaLookup: (name) =>
        Promise.resolve(
          name === 'example.com' ? [{ critical: false, tag: 'issue', value: 'other.example' }] : []
        ),
    },
  })
  assertEquals(blocked.ready, false)
  assertEquals(blocked.hostnames[0]!.caa, 'blocked')
  assertEquals(blocked.hostnames[0]!.problem?.includes('CAA record on example.com'), true)

  const allowed = await checkHostingDns({
    hostnames: ['shop.example.com'],
    expectedAddresses: ['198.51.100.7'],
    lookup: table({ 'shop.example.com/A': ['198.51.100.7'] }),
    now: NOW,
    probes: {
      port80: () => Promise.resolve({ state: 'open' as const }),
      caaLookup: () =>
        Promise.resolve([
          { critical: false, tag: 'issue', value: 'letsencrypt.org; validationmethods=http-01' },
        ]),
    },
  })
  assertEquals(allowed.ready, true)
  assertEquals(allowed.hostnames[0]!.port80, 'open')
  assertEquals(allowed.hostnames[0]!.caa, 'allowed')
})

test('a right public A beside a private or loopback A still blocks and the private one is never dialed', async () => {
  for (const other of ['10.0.0.5', '127.0.0.1']) {
    const dialed: string[][] = []
    const report = await checkHostingDns({
      hostnames: ['a.example.com'],
      expectedAddresses: ['198.51.100.7'],
      lookup: table({ 'a.example.com/A': ['198.51.100.7', other] }),
      now: NOW,
      probes: {
        port80: (_name, addresses) => {
          dialed.push([...addresses])
          return Promise.resolve({ state: 'open' as const })
        },
      },
    })
    assertEquals(report.ready, false, other)
    assertEquals(report.hostnames[0]!.warning, undefined, other)
    assertEquals(report.hostnames[0]!.problem?.includes(other), true, other)
    assertEquals(dialed, [], other)
  }
})
