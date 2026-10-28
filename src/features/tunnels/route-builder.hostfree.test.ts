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
  // The server it forwards to is a peer too, so a stale table can never loop.
  assertEquals(built.peerAddresses, ['fd00::b'])
  assertEquals(built.listenAddresses, ['fd00::a', '10.0.0.10'])
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
    { routes: [], peerAddresses: [], listenAddresses: [], needsPeerMaterial: false, skipped: [] },
    undefined
  )
  assertEquals(parseTunnelRoutesPayload(empty).routes, [])
})
