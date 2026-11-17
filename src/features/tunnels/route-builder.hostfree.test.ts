import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert'
import { parseTunnelRoutesPayload } from '../../contracts/commands/tunnel-routes.ts'
import {
  buildTunnelRoutes,
  hashTunnelRoutes,
  toRoutesPayload,
  unroutedReasons,
  type AddressBook,
  type ServerAddresses,
} from './route-builder.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

/** Addresses in one datacenter, plus any public ones. */
const inDc = (list: string[], pub: string[] = [], dc = 'dc1') => ({
  datacenters: { [dc]: list },
  public: pub,
})

const book = new Map([
  [A, inDc(['fd00::a', '10.0.0.10'])],
  [B, inDc(['fd00::b', '10.0.0.11'])],
  [C, inDc(['10.0.0.12'])],
])

test('a name whose site runs elsewhere is forwarded to that server', () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 'shop.example.com', siteServerIds: [B], isLocalOnly: true }],
      },
    ],
    book
  )
  assertEquals(built.routes, [
    {
      hostname: 'shop.example.com',
      local: false,
      lock: true,
      upstreams: [{ serverId: B, addresses: ['fd00::b'], localAddress: 'fd00::a' }],
    },
  ])
  // A carrier-only server has no inbound peers: the list is empty and it listens on nothing extra.
  assertEquals(built.peerAddresses, [])
  assertEquals(built.listenAddresses, [])
  assertEquals(built.needsPeerMaterial, true)
})

test('a name whose site runs here is local and has no upstream', () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A, B],
        doorways: [{ hostname: 'a.example.com', siteServerIds: [A], isLocalOnly: false }],
      },
    ],
    book
  )
  assertEquals(built.routes, [
    { hostname: 'a.example.com', local: true, lock: false, upstreams: [] },
  ])
  // The other carrying server may send visitors here, so its exact addresses are the peers.
  assertEquals(built.peerAddresses, ['fd00::b'])
  // One IP version per pair: IPv6, the datacenter's first.
  assertEquals(built.listenAddresses, ['fd00::a'])
})

test('a server that hosts the site but does not carry the tunnel gets peers and no routes', () => {
  const built = buildTunnelRoutes(
    C,
    [
      {
        carrying: [A, B],
        doorways: [{ hostname: 'c.example.com', siteServerIds: [C], isLocalOnly: true }],
      },
    ],
    book
  )
  assertEquals(built.routes, [])
  assertEquals(built.peerAddresses, ['10.0.0.10', '10.0.0.11'])
  assertEquals(built.needsPeerMaterial, true)
})

test('a name with no site or no datacenter address is skipped with a reason', () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [
          { hostname: 'none.example.com', siteServerIds: [], isLocalOnly: true },
          {
            hostname: 'noaddr.example.com',
            siteServerIds: ['00000000-0000-4000-8000-0000000000ff'],
            isLocalOnly: true,
          },
        ],
      },
    ],
    book
  )
  assertEquals(built.routes, [])
  assertEquals(
    built.skipped.map((s) => s.hostname),
    ['none.example.com', 'noaddr.example.com']
  )
  assertEquals(built.needsPeerMaterial, false)
})

test('a server that carries nothing and hosts nothing gets an empty plan', () => {
  const built = buildTunnelRoutes(
    C,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 'x.example.com', siteServerIds: [B], isLocalOnly: true }],
      },
    ],
    book
  )
  assertEquals(built, {
    routes: [],
    peerAddresses: [],
    listenAddresses: [],
    needsPeerMaterial: false,
    skipped: [],
    warnings: [],
  })
})

test('routes are sorted and a name on two tunnels is listed once', () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 'b.example.com', siteServerIds: [B], isLocalOnly: true }],
      },
      {
        carrying: [A],
        doorways: [
          { hostname: 'a.example.com', siteServerIds: [B], isLocalOnly: true },
          { hostname: 'b.example.com', siteServerIds: [B], isLocalOnly: true },
        ],
      },
    ],
    book
  )
  assertEquals(
    built.routes.map((r) => r.hostname),
    ['a.example.com', 'b.example.com']
  )
})

test('the hash follows the routes and the certificate but not the sealed key', async () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 's.example.com', siteServerIds: [B], isLocalOnly: true }],
      },
    ],
    book
  )
  const cert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'
  const one = await hashTunnelRoutes(built, { certificatePem: cert, caCertPem: cert })
  assertEquals(one, await hashTunnelRoutes(built, { certificatePem: cert, caCertPem: cert }))
  assert(one !== (await hashTunnelRoutes(built, { certificatePem: cert + ' ', caCertPem: cert })))
  assert(
    one !==
      (await hashTunnelRoutes({ ...built, routes: [] }, { certificatePem: cert, caCertPem: cert }))
  )
  assert(/^[0-9a-f]{64}$/.test(one))
})

test('the payload passes the daemon contract parser, and material is required when needed', async () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 's.example.com', siteServerIds: [B], isLocalOnly: true }],
      },
    ],
    book
  )
  await assertRejects(() => toRoutesPayload(built, undefined), Error, 'Peer material is required')
  const cert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'
  const payload = await toRoutesPayload(built, {
    certificatePem: cert,
    privateKeyEnvelope: 'tpdaemon.sealed',
    caCertPem: cert,
  })
  assertEquals(parseTunnelRoutesPayload(payload).routes.length, 1)
  const empty = await toRoutesPayload(
    {
      routes: [],
      peerAddresses: [],
      listenAddresses: [],
      needsPeerMaterial: false,
      skipped: [],
      warnings: [],
    },
    undefined
  )
  assertEquals(parseTunnelRoutesPayload(empty).routes, [])
})

test('a table above the contract caps is cut and says so, never sent whole', () => {
  const many = Array.from(
    { length: 20 },
    (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
  )
  const book2 = new Map<string, ServerAddresses>([[A, inDc(['10.0.0.1'])]])
  many.forEach((id, i) =>
    book2.set(id, inDc(Array.from({ length: 10 }, (_, k) => `10.1.${i}.${k + 1}`)))
  )
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 'big.example.com', siteServerIds: many, isLocalOnly: true }],
      },
    ],
    book2
  )
  assertEquals(built.routes[0]!.upstreams.length, 16)
  assertEquals(built.routes[0]!.upstreams[0]!.addresses.length, 8)
  const hosted = buildTunnelRoutes(
    many[0]!,
    [
      {
        carrying: many.slice(1),
        doorways: [{ hostname: 'big.example.com', siteServerIds: [many[0]!], isLocalOnly: true }],
      },
    ],
    new Map(
      many.map((id, i) => [id, inDc([`10.1.${i}.1`, `10.2.${i}.1`, `10.3.${i}.1`, `10.4.${i}.1`])])
    )
  )
  assertEquals(hosted.peerAddresses.length, 64)
  assert(hosted.warnings[0]!.includes('64 peer addresses'))
  parseTunnelRoutesPayload({
    hash: 'a'.repeat(64),
    routes: built.routes,
    peerAddresses: hosted.peerAddresses,
    peerMaterial: {
      certificatePem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      privateKeyEnvelope: 'tpdaemon.sealed',
      caCertPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
    },
  })
})

test('the hash of a fixed table is pinned, so the order feeding it never drifts between runtimes', async () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [
          { hostname: 'b.example.com', siteServerIds: [B, C], isLocalOnly: true },
          { hostname: 'a.example.com', siteServerIds: [B], isLocalOnly: false },
        ],
      },
    ],
    book
  )
  const cert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'
  assertEquals(
    await hashTunnelRoutes(built, { certificatePem: cert, caCertPem: cert }),
    'd3ca46a05e562eb17d86709341291dbd5f42d47624a82c95746b6b18148168b1'
  )
})

test('a server that runs a site learns, per name, the other carriers of that name only', () => {
  const tunnels = [
    {
      // Tunnel 1 runs on B and C; its site runs on A.
      carrying: [B, C],
      doorways: [{ hostname: 'one.example.com', siteServerIds: [A], isLocalOnly: true }],
    },
    {
      // Tunnel 2 runs on C only; its site runs on A too.
      carrying: [C],
      doorways: [{ hostname: 'two.example.com', siteServerIds: [A], isLocalOnly: true }],
    },
    {
      // Tunnel 3 runs on A alone; its site runs on A: nobody else may forward it.
      carrying: [A],
      doorways: [{ hostname: 'solo.example.com', siteServerIds: [A], isLocalOnly: true }],
    },
  ]
  const built = buildTunnelRoutes(A, tunnels, book, { withInbound: true })
  assertEquals(built.inbound, [
    { hostname: 'one.example.com', peers: ['10.0.0.12', 'fd00::b'] },
    { hostname: 'solo.example.com', peers: [] },
    // Not B: B carries tunnel 1, not this name's tunnel.
    { hostname: 'two.example.com', peers: ['10.0.0.12'] },
  ])
  // The server-wide list stays the union, as before.
  assertEquals(built.peerAddresses, ['10.0.0.12', 'fd00::b'])
  // A carrier that runs no site gets an empty list; asked for nothing, nothing is set.
  assertEquals(buildTunnelRoutes(B, tunnels, book, { withInbound: true }).inbound, [])
  assertEquals(buildTunnelRoutes(A, tunnels, book).inbound, undefined)
})

test('a table with names to lock passes the daemon parser, with or without a certificate', async () => {
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 'solo.example.com', siteServerIds: [A], isLocalOnly: true }],
      },
    ],
    book,
    { withInbound: true }
  )
  assertEquals(built.needsPeerMaterial, true)
  const lone = buildTunnelRoutes(
    B,
    [
      {
        carrying: [C],
        doorways: [{ hostname: 'x.example.com', siteServerIds: [B], isLocalOnly: true }],
      },
    ],
    book,
    { withInbound: true }
  )
  assertEquals(lone.routes, [])
  assertEquals(lone.inbound, [{ hostname: 'x.example.com', peers: ['10.0.0.12'] }])
  const payload = await toRoutesPayload(lone, {
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    privateKeyEnvelope: 'tpdaemon.AAAA',
    caCertPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  })
  assertEquals(parseTunnelRoutesPayload(payload).inbound, lone.inbound)
  // Nobody else carries the name any more: only the lock goes out, loopback alone, no certificate.
  const alone = buildTunnelRoutes(
    A,
    [
      {
        carrying: [],
        doorways: [{ hostname: 'x.example.com', siteServerIds: [A], isLocalOnly: true }],
      },
    ],
    book,
    { withInbound: true }
  )
  assertEquals(alone.needsPeerMaterial, false)
  assertEquals(alone.inbound, [{ hostname: 'x.example.com', peers: [] }])
  assertEquals(
    parseTunnelRoutesPayload(await toRoutesPayload(alone, undefined)).inbound,
    alone.inbound
  )
})

test('the hash of a table without inbound is what it was, and inbound changes it', async () => {
  const tunnels = [
    {
      carrying: [B],
      doorways: [{ hostname: 'one.example.com', siteServerIds: [A], isLocalOnly: true }],
    },
  ]
  const plain = buildTunnelRoutes(A, tunnels, book)
  const withInbound = buildTunnelRoutes(A, tunnels, book, { withInbound: true })
  const { inbound: _dropped, ...withoutField } = withInbound
  assertEquals(
    await hashTunnelRoutes(plain, undefined),
    await hashTunnelRoutes(withoutField, undefined)
  )
  assert(
    (await hashTunnelRoutes(plain, undefined)) !== (await hashTunnelRoutes(withInbound, undefined))
  )
})

test('lock: true goes out per name, only for local-only names and only when the daemon can add a lock', async () => {
  const tunnels = [
    {
      carrying: [B],
      doorways: [
        { hostname: 'locked.example.com', siteServerIds: [A], isLocalOnly: true },
        { hostname: 'open.example.com', siteServerIds: [A], isLocalOnly: false },
      ],
    },
  ]
  const options = { withInbound: true, withLockAdd: true }
  const built = buildTunnelRoutes(A, tunnels, book, options)
  assertEquals(built.inbound, [
    { hostname: 'locked.example.com', peers: ['fd00::b'], lock: true },
    { hostname: 'open.example.com', peers: ['fd00::b'] },
  ])
  // A daemon that follows the table but cannot add a lock gets the table it always got.
  const follow = buildTunnelRoutes(A, tunnels, book, { withInbound: true })
  assertEquals(follow.inbound, [
    { hostname: 'locked.example.com', peers: ['fd00::b'] },
    { hostname: 'open.example.com', peers: ['fd00::b'] },
  ])
  // No inbound at all: withLockAdd alone sends nothing.
  assertEquals(buildTunnelRoutes(A, tunnels, book, { withLockAdd: true }).inbound, undefined)
  // The lock is part of the hash, and the daemon parser keeps it.
  assert((await hashTunnelRoutes(built, undefined)) !== (await hashTunnelRoutes(follow, undefined)))
  assertEquals(
    parseTunnelRoutesPayload(
      await toRoutesPayload(built, {
        certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
        privateKeyEnvelope: 'tpdaemon.AAAA',
        caCertPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      })
    ).inbound,
    built.inbound
  )
})

test('peerClientAuth is sent only when asked for, and changes the hash', async () => {
  const tunnels = [
    {
      carrying: [A],
      doorways: [{ hostname: 's.example.com', siteServerIds: [B], isLocalOnly: false }],
    },
  ]
  const cert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'
  const material = { certificatePem: cert, caCertPem: cert }
  const plain = buildTunnelRoutes(A, tunnels, book)
  const verified = buildTunnelRoutes(A, tunnels, book, { peerClientAuth: 'verify' })
  assertEquals(plain.peerClientAuth, undefined)
  assertEquals(verified.peerClientAuth, 'verify')
  assert((await hashTunnelRoutes(plain, material)) !== (await hashTunnelRoutes(verified, material)))
  const payload = await toRoutesPayload(verified, {
    certificatePem: cert,
    privateKeyEnvelope: 'tpdaemon.sealed',
    caCertPem: cert,
  })
  assertEquals(parseTunnelRoutesPayload(payload).peerClientAuth, 'verify')
  const required = buildTunnelRoutes(A, tunnels, book, { peerClientAuth: 'require' })
  assertEquals(required.peerClientAuth, 'require')
  assert(
    (await hashTunnelRoutes(verified, material)) !== (await hashTunnelRoutes(required, material))
  )
  assertEquals(
    'peerClientAuth' in
      (await toRoutesPayload(plain, {
        certificatePem: cert,
        privateKeyEnvelope: 'tpdaemon.sealed',
        caCertPem: cert,
      })),
    false
  )
  assertThrows(
    () => parseTunnelRoutesPayload({ ...payload, peerClientAuth: 'always' }),
    TypeError,
    'peerClientAuth'
  )
})

const PUBLIC_A = '192.0.2.10'
const PUBLIC_B = '192.0.2.11'

const shop = (site: string) => [
  {
    carrying: [A],
    doorways: [{ hostname: 'shop.example.com', siteServerIds: [site], isLocalOnly: true }],
  },
]

const PUBLIC_C = '192.0.2.12'

const pub = (...list: string[]): ServerAddresses => ({ datacenters: {}, public: list })

test('a site server with no datacenter address is reached on its public address', () => {
  const addresses: AddressBook = new Map([
    [A, pub(PUBLIC_A)],
    [B, pub(PUBLIC_B)],
  ])
  const built = buildTunnelRoutes(A, shop(B), addresses)
  assertEquals(built.routes[0].upstreams, [
    { serverId: B, addresses: [PUBLIC_B], localAddress: PUBLIC_A },
  ])
  assertEquals(built.skipped, [])
  // The hop stays authenticated: the table still asks for peer material.
  assertEquals(built.needsPeerMaterial, true)
})

test('the peer side admits the connector server public address too', () => {
  const addresses: AddressBook = new Map([
    [A, pub(PUBLIC_A)],
    [B, pub(PUBLIC_B)],
  ])
  const built = buildTunnelRoutes(B, shop(B), addresses, { withInbound: true })
  assertEquals(built.peerAddresses, [PUBLIC_A])
  assertEquals(built.listenAddresses, [PUBLIC_B])
  assertEquals(built.inbound, [{ hostname: 'shop.example.com', peers: [PUBLIC_A] }])
})

test('a shared datacenter address is preferred over public addresses on both sides', () => {
  const addresses: AddressBook = new Map([
    [A, inDc(['fd00::a'], [PUBLIC_A])],
    [B, inDc(['fd00::b'], [PUBLIC_B])],
  ])
  const sender = buildTunnelRoutes(A, shop(B), addresses)
  assertEquals(sender.routes[0].upstreams, [
    { serverId: B, addresses: ['fd00::b'], localAddress: 'fd00::a' },
  ])
  const receiver = buildTunnelRoutes(B, shop(B), addresses)
  assertEquals(receiver.peerAddresses, ['fd00::a'])
  assertEquals(receiver.listenAddresses, ['fd00::b'])
})

/**
 * One choice per pair: the upstream the carrier dials, the peers the site server
 * admits, its listen addresses, the firewall rule and the address lock all use
 * the same family, so no side is left on an address the other does not know.
 */
function assertAgree(addresses: AddressBook, carrierSide: string[], siteSide: string[]): void {
  const sender = buildTunnelRoutes(A, shop(B), addresses)
  assertEquals(sender.routes[0].upstreams, [
    { serverId: B, addresses: siteSide, localAddress: carrierSide[0] },
  ])
  const receiver = buildTunnelRoutes(B, shop(B), addresses, { withInbound: true })
  assertEquals(receiver.peerAddresses, carrierSide)
  assertEquals(receiver.listenAddresses, siteSide)
  assertEquals(receiver.inbound, [{ hostname: 'shop.example.com', peers: carrierSide }])
}

test('a connector in a datacenter and a public-only site server both use public addresses', () => {
  assertAgree(
    new Map([
      [A, inDc(['fd00::a'], [PUBLIC_A])],
      [B, pub(PUBLIC_B)],
    ]),
    [PUBLIC_A],
    [PUBLIC_B]
  )
})

test('a public-only connector and a site server in a datacenter both use public addresses', () => {
  assertAgree(
    new Map([
      [A, pub(PUBLIC_A)],
      [B, inDc(['fd00::b'], [PUBLIC_B])],
    ]),
    [PUBLIC_A],
    [PUBLIC_B]
  )
})

test('servers in different datacenters use public addresses, not either datacenter', () => {
  assertAgree(
    new Map([
      [A, inDc(['fd00::a'], [PUBLIC_A], 'dc1')],
      [B, inDc(['fd00::b'], [PUBLIC_B], 'dc2')],
    ]),
    [PUBLIC_A],
    [PUBLIC_B]
  )
})

test('different datacenters with no public address on a side skip the name', () => {
  const addresses: AddressBook = new Map([
    [A, inDc(['fd00::a'], [], 'dc1')],
    [B, inDc(['fd00::b'], [PUBLIC_B], 'dc2')],
  ])
  const built = buildTunnelRoutes(A, shop(B), addresses)
  assertEquals(built.routes, [])
  assertEquals(built.skipped.length, 1)
  // Nothing is opened on the site server either.
  assertEquals(buildTunnelRoutes(B, shop(B), addresses).peerAddresses, [])
})

test('each carrier and site server pair is chosen on its own', () => {
  // A and B share a datacenter; C is elsewhere with a public address only.
  const addresses: AddressBook = new Map([
    [A, inDc(['fd00::a'], [PUBLIC_A])],
    [B, inDc(['fd00::b'], [PUBLIC_B])],
    [C, pub(PUBLIC_C)],
  ])
  const tunnels = [
    {
      carrying: [A, C],
      doorways: [{ hostname: 'shop.example.com', siteServerIds: [B], isLocalOnly: true }],
    },
  ]
  const receiver = buildTunnelRoutes(B, tunnels, addresses)
  // A reaches B on their shared datacenter; C shares none with B, so C and B use public addresses.
  assertEquals(receiver.peerAddresses, [PUBLIC_C, 'fd00::a'].toSorted())
  assertEquals(receiver.listenAddresses, ['fd00::b', PUBLIC_B])
  assertEquals(buildTunnelRoutes(A, tunnels, addresses).routes[0].upstreams, [
    { serverId: B, addresses: ['fd00::b'], localAddress: 'fd00::a' },
  ])
  assertEquals(buildTunnelRoutes(C, tunnels, addresses).routes[0].upstreams, [
    { serverId: B, addresses: [PUBLIC_B], localAddress: PUBLIC_C },
  ])
})

test('servers with only IPv6 public addresses use them', () => {
  assertAgree(
    new Map([
      [A, pub('2001:db8::a')],
      [B, pub('2001:db8::b')],
    ]),
    ['2001:db8::a'],
    ['2001:db8::b']
  )
})

test('dual-stack servers use IPv4 on both sides', () => {
  assertAgree(
    new Map([
      [A, pub('2001:db8::a', PUBLIC_A)],
      [B, pub('2001:db8::b', PUBLIC_B)],
    ]),
    [PUBLIC_A],
    [PUBLIC_B]
  )
})

test('servers that share no IP version are skipped with a reason and nothing is allowed', () => {
  for (const [carrier, site] of [
    [pub(PUBLIC_A), pub('2001:db8::b')],
    [pub('2001:db8::a'), pub(PUBLIC_B)],
  ]) {
    const addresses: AddressBook = new Map([
      [A, carrier],
      [B, site],
    ])
    const built = buildTunnelRoutes(A, shop(B), addresses)
    assertEquals(built.routes, [])
    assertEquals(built.skipped.length, 1)
    assert(built.skipped[0].reason.includes('share no IP version'))
    const receiver = buildTunnelRoutes(B, shop(B), addresses, { withInbound: true })
    assertEquals(receiver.peerAddresses, [])
    assertEquals(receiver.listenAddresses, [])
  }
})

test('a datacenter with no shared IP version falls back to public addresses', () => {
  const addresses: AddressBook = new Map([
    [A, { datacenters: { dc1: ['10.0.0.1'] }, public: [PUBLIC_A] }],
    [B, { datacenters: { dc1: ['fd00::b'] }, public: [PUBLIC_B] }],
  ])
  assertEquals(buildTunnelRoutes(A, shop(B), addresses).routes[0].upstreams, [
    { serverId: B, addresses: [PUBLIC_B], localAddress: PUBLIC_A },
  ])
})

test('listen addresses cut at the cap say so', () => {
  const carriers = Array.from(
    { length: 2 },
    (_, i) => `00000000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`
  )
  const addresses = new Map<string, ServerAddresses>([
    [B, inDc(Array.from({ length: 70 }, (_, i) => `10.9.0.${i + 1}`))],
    ...carriers.map((id, i) => [id, inDc([`10.8.0.${i + 1}`])] as [string, ServerAddresses]),
  ])
  const built = buildTunnelRoutes(
    B,
    [
      {
        carrying: carriers,
        doorways: [{ hostname: 'shop.example.com', siteServerIds: [B], isLocalOnly: true }],
      },
    ],
    addresses
  )
  assertEquals(built.listenAddresses.length, 64)
  assert(built.warnings.some((w) => w.includes('64 listen addresses')))
})

test('with no address of any kind the name is skipped and the reason is reported', () => {
  const addresses: AddressBook = new Map()
  const built = buildTunnelRoutes(A, shop(B), addresses)
  assertEquals(built.routes, [])
  assertEquals(built.skipped.length, 1)
  const reasons = unroutedReasons([A], shop(B), addresses)
  assertEquals(reasons.get('shop.example.com'), built.skipped[0].reason)
  assert(reasons.get('shop.example.com')?.includes('an address this server can reach'))
  // A routed name has no entry.
  const routed: AddressBook = new Map([
    [A, pub(PUBLIC_A)],
    [B, pub(PUBLIC_B)],
  ])
  assertEquals(unroutedReasons([A], shop(B), routed).size, 0)
})

test('a server with only IPv4 sends from its IPv4 address, and that address is the one the receiver admits', () => {
  const addresses: AddressBook = new Map([
    [A, pub(PUBLIC_A)],
    [B, pub(PUBLIC_B)],
  ])
  const sender = buildTunnelRoutes(A, shop(B), addresses)
  assertEquals(sender.routes[0].upstreams[0].localAddress, PUBLIC_A)
  const receiver = buildTunnelRoutes(B, shop(B), addresses, { withInbound: true })
  assert(receiver.peerAddresses.includes(PUBLIC_A))
  assertEquals(receiver.inbound?.[0].peers, [PUBLIC_A])
})

test('a server with both families sends from the address of the family the hop uses', () => {
  // Public addresses: both families on both sides, IPv4 wins.
  const publicBook: AddressBook = new Map([
    [A, pub('2001:db8::a', PUBLIC_A)],
    [B, pub('2001:db8::b', PUBLIC_B)],
  ])
  const upstream = buildTunnelRoutes(A, shop(B), publicBook).routes[0].upstreams[0]
  assertEquals(upstream.addresses, [PUBLIC_B])
  assertEquals(upstream.localAddress, PUBLIC_A)
  // A datacenter that prefers IPv6: the IPv6 pair is used on both sides.
  const dcBook: AddressBook = new Map([
    [A, inDc(['fd00::a', '10.0.0.10'])],
    [B, inDc(['fd00::b', '10.0.0.11'])],
  ])
  const v6 = buildTunnelRoutes(A, shop(B), dcBook).routes[0].upstreams[0]
  assertEquals(v6.addresses, ['fd00::b'])
  assertEquals(v6.localAddress, 'fd00::a')
  // The sender has IPv6 only on the shared network, the site IPv4 only: no shared family, no table entry.
  const mixed: AddressBook = new Map([
    [A, pub('2001:db8::a')],
    [B, pub(PUBLIC_B)],
  ])
  assertEquals(buildTunnelRoutes(A, shop(B), mixed).routes, [])
})

test('every pair has its own source address and the payload carries it through the contract parser', async () => {
  const addresses: AddressBook = new Map([
    [A, inDc(['fd00::a'], [PUBLIC_A])],
    [B, inDc(['fd00::b'], [PUBLIC_B])],
    [C, pub(PUBLIC_C)],
  ])
  const built = buildTunnelRoutes(
    A,
    [
      {
        carrying: [A],
        doorways: [{ hostname: 'shop.example.com', siteServerIds: [B, C], isLocalOnly: true }],
      },
    ],
    addresses
  )
  assertEquals(
    built.routes[0].upstreams.map((u) => [u.serverId, u.localAddress]),
    [
      [B, 'fd00::a'],
      [C, PUBLIC_A],
    ]
  )
  const cert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'
  const payload = await toRoutesPayload(built, {
    certificatePem: cert,
    caCertPem: cert,
    privateKeyEnvelope: 'tpdaemon.sealed',
  })
  assertEquals(
    parseTunnelRoutesPayload(payload).routes[0].upstreams.map((u) => u.localAddress),
    ['fd00::a', PUBLIC_A]
  )
})

test('a changed source address changes the hash, so the table is sent again', async () => {
  const table = (own: string) =>
    buildTunnelRoutes(
      A,
      shop(B),
      new Map([
        [A, pub(own)],
        [B, pub(PUBLIC_B)],
      ])
    )
  assert(
    (await hashTunnelRoutes(table(PUBLIC_A), undefined)) !==
      (await hashTunnelRoutes(table(PUBLIC_C), undefined))
  )
})
