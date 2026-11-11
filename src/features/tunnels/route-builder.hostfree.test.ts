import { assert, assertEquals, assertRejects } from '@std/assert'
import { parseTunnelRoutesPayload } from '../../contracts/commands/tunnel-routes.ts'
import { buildTunnelRoutes, hashTunnelRoutes, toRoutesPayload } from './route-builder.ts'

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

const book = new Map([
  [A, ['fd00::a', '10.0.0.10']],
  [B, ['fd00::b']],
  [C, ['10.0.0.12']],
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
      upstreams: [{ serverId: B, addresses: ['fd00::b'] }],
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
  assertEquals(built.listenAddresses, ['fd00::a', '10.0.0.10'])
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
  assertEquals(built.peerAddresses, ['10.0.0.10', 'fd00::a', 'fd00::b'].sort())
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
  const book2 = new Map<string, string[]>([[A, ['10.0.0.1']]])
  many.forEach((id, i) =>
    book2.set(
      id,
      Array.from({ length: 10 }, (_, k) => `10.1.${i}.${k + 1}`)
    )
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
    new Map(many.map((id, i) => [id, [`10.1.${i}.1`, `10.2.${i}.1`, `10.3.${i}.1`, `10.4.${i}.1`]]))
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
    '2d07617b9051cf5724a4c2980733b865d8914d320b5453ee08a178af2d8fb168'
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
