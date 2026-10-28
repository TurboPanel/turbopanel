import { assertEquals, assertThrows } from '@std/assert'
import {
  parseCommandPayload,
  parseCommandResult,
  parseEnvironmentDeployPayload,
} from './schemas.ts'
import { parseDeployHostingTunnel, parseTunnelRoutesPayload } from './tunnel-routes.ts'

/** Sonar only recognises `test()`; see backups-reconcile.hostfree.test.ts. */
const test = Deno.test.bind(Deno)

const HASH = 'a'.repeat(64)
const SERVER_A = '0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01'
const SERVER_B = '0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e02'
const CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
const MATERIAL = {
  certificatePem: CERT,
  privateKeyEnvelope: 'tpdaemon.AAAA',
  caCertPem: CERT,
  notAfter: '2027-01-01T00:00:00.000Z',
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: HASH,
    routes: [
      {
        hostname: 'app.example.com',
        local: false,
        lock: true,
        upstreams: [
          { serverId: SERVER_A, addresses: ['10.0.0.5', 'fd00::5'], port: 443 },
          { serverId: SERVER_B, addresses: ['10.0.0.6'] },
        ],
      },
      { hostname: 'here.example.com', local: true, lock: true, upstreams: [] },
    ],
    peerAddresses: ['10.0.0.5', '10.0.0.6'],
    listenAddresses: ['10.0.0.7'],
    peerMaterial: MATERIAL,
    ...overrides,
  }
}

test('server.tunnel.routes payload round-trips through the command parser', () => {
  const parsed = parseCommandPayload('server.tunnel.routes', payload())
  assertEquals(parsed, payload())
})

test('server.tunnel.routes: an empty table needs no material and removes the file', () => {
  const empty = { hash: HASH, routes: [], peerAddresses: [] }
  assertEquals(parseTunnelRoutesPayload(empty), empty)
})

test('server.tunnel.routes refuses bad shapes', () => {
  const cases: Record<string, unknown>[] = [
    payload({ hash: 'ABC' }),
    payload({ peerMaterial: undefined }),
    payload({ peerAddresses: [] }),
    payload({ peerAddresses: ['10.0.0.0/24'] }),
    payload({ peerAddresses: ['10.0.0.5', '10.0.0.5'] }),
    payload({ listenAddresses: ['not-an-ip'] }),
    payload({ peerMaterial: { ...MATERIAL, privateKeyEnvelope: 'plain-key' } }),
    payload({ peerMaterial: { ...MATERIAL, caCertPem: 'nope' } }),
    payload({ peerMaterial: { ...MATERIAL, notAfter: 'tomorrow' } }),
    payload({ routes: [{ hostname: 'App.Example.com', local: false, lock: true, upstreams: [] }] }),
    payload({ routes: [{ hostname: 'a.example.com', local: false, lock: true, upstreams: [] }] }),
    payload({
      routes: [
        { hostname: 'a.example.com', local: true, lock: true, upstreams: [] },
        { hostname: 'a.example.com', local: true, lock: true, upstreams: [] },
      ],
    }),
    payload({
      routes: [
        {
          hostname: 'a.example.com',
          local: false,
          lock: true,
          upstreams: [{ serverId: SERVER_A, addresses: ['10.0.0.5'], port: 70000 }],
        },
      ],
    }),
    payload({
      routes: [
        {
          hostname: 'a.example.com',
          local: false,
          lock: true,
          upstreams: [{ serverId: 'not-a-uuid', addresses: ['10.0.0.5'] }],
        },
      ],
    }),
    payload({
      routes: [
        {
          hostname: 'a.example.com',
          local: false,
          lock: true,
          upstreams: [{ serverId: SERVER_A, addresses: [] }],
        },
      ],
    }),
  ]
  for (const bad of cases) {
    assertThrows(() => parseTunnelRoutesPayload(bad), TypeError)
  }
  assertThrows(() => parseTunnelRoutesPayload(null), TypeError)
})

test('server.tunnel.routes result round-trips and refuses bad shapes', () => {
  const result = {
    hash: HASH,
    applied: true,
    routeCount: 1,
    dropped: ['here.example.com'],
    warnings: [],
  }
  assertEquals(parseCommandResult('server.tunnel.routes', result), result)
  assertThrows(
    () => parseCommandResult('server.tunnel.routes', { ...result, routeCount: -1 }),
    TypeError
  )
  assertThrows(
    () => parseCommandResult('server.tunnel.routes', { ...result, hash: 'x' }),
    TypeError
  )
})

test('hostings[].tunnel parses, stays optional and checks its names', () => {
  const site = ['app.example.com', 'www.example.com']
  assertEquals(parseDeployHostingTunnel(undefined, site), undefined)
  const tunnel = {
    hostnames: ['app.example.com', 'www.example.com'],
    openHostnames: ['www.example.com'],
    peers: ['10.0.0.5', 'fd00::5'],
    extraBind: ['10.0.0.7'],
  }
  assertEquals(parseDeployHostingTunnel(tunnel, site), tunnel)
  assertEquals(
    parseDeployHostingTunnel({ hostnames: ['app.example.com'], peers: ['10.0.0.5'] }, site),
    {
      hostnames: ['app.example.com'],
      peers: ['10.0.0.5'],
    }
  )
  const bad: unknown[] = [
    { ...tunnel, hostnames: ['other.example.com'] },
    { ...tunnel, openHostnames: ['other.example.com'] },
    { ...tunnel, peers: [] },
    { ...tunnel, peers: ['10.0.0.0/24'] },
    { ...tunnel, extraBind: ['x'] },
    { ...tunnel, hostnames: [] },
    'text',
  ]
  for (const value of bad) {
    assertThrows(() => parseDeployHostingTunnel(value, site), TypeError)
  }
})

test('environment.deploy carries hostings[].tunnel to the daemon and old payloads still parse', () => {
  const base = {
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    hostingIngressNetwork: 'tp-demo-net',
    composeFiles: [{ filename: 'compose.yaml', role: 'runtime', content: 'services: {}\\n' }],
    hostings: [
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'web',
        hostnames: ['app.example.com'],
      },
    ],
  }
  const plain = parseEnvironmentDeployPayload(base)
  assertEquals(plain.hostings?.[0]?.tunnel, undefined)
  const withTunnel = parseEnvironmentDeployPayload({
    ...base,
    hostings: [
      { ...base.hostings[0], tunnel: { hostnames: ['app.example.com'], peers: ['10.0.0.5'] } },
    ],
  })
  assertEquals(withTunnel.hostings?.[0]?.tunnel, {
    hostnames: ['app.example.com'],
    peers: ['10.0.0.5'],
  })
})

test('environment.deploy refuses acme for a name that is only a tunnel name', () => {
  const entry = (tunnel: Record<string, unknown>) => ({
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    hostingIngressNetwork: 'tp-demo-net',
    composeFiles: [{ filename: 'compose.yaml', role: 'runtime', content: 'services: {}' }],
    hostings: [
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'web',
        hostnames: ['app.example.com'],
        tlsMode: 'acme',
        tunnel,
      },
    ],
  })
  assertThrows(() =>
    parseEnvironmentDeployPayload(entry({ hostnames: ['app.example.com'], peers: ['10.0.0.5'] }))
  )
  const ok = parseEnvironmentDeployPayload(
    entry({
      hostnames: ['app.example.com'],
      openHostnames: ['app.example.com'],
      peers: ['10.0.0.5'],
    })
  )
  assertEquals(ok.hostings?.[0]?.tlsMode, 'acme')
})

test('server.tunnel.routes: material, peers and size limits', () => {
  const route = (n: number) => ({
    hostname: `n${n}.example.com`,
    local: true,
    lock: true,
    upstreams: [],
  })
  const ips = (n: number) =>
    Array.from({ length: n }, (_, i) => `10.0.${Math.floor(i / 200)}.${(i % 200) + 1}`)
  const ok = payload()
  const material = ok.peerMaterial as Record<string, unknown>
  const cases: Record<string, unknown>[] = [
    // peers listed but no material
    payload({ peerMaterial: undefined, routes: [] }),
    // size limits
    payload({ routes: Array.from({ length: 2001 }, (_, i) => route(i)) }),
    payload({ peerAddresses: ips(65) }),
    payload({
      routes: [
        {
          hostname: 'a.example.com',
          local: false,
          lock: true,
          upstreams: [{ serverId: SERVER_A, addresses: ips(9) }],
        },
      ],
    }),
    payload({
      routes: [
        {
          hostname: 'a.example.com',
          local: false,
          lock: true,
          upstreams: Array.from({ length: 17 }, (_, i) => ({
            serverId: `0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e${String(i).padStart(2, '0')}`,
            addresses: ['10.0.0.5'],
          })),
        },
      ],
    }),
    // material
    payload({
      peerMaterial: { ...material, certificatePem: CERT + '-----BEGIN PRIVATE KEY-----\nx\n' },
    }),
    payload({ peerMaterial: { ...material, caCertPem: CERT + 'PRIVATE KEY' } }),
    payload({ peerMaterial: { ...material, certificatePem: CERT + 'a'.repeat(70_000) } }),
    payload({ peerMaterial: { ...material, caCertPem: CERT + 'a'.repeat(70_000) } }),
    payload({
      peerMaterial: { ...material, privateKeyEnvelope: 'tpdaemon.' + 'a'.repeat(70_000) },
    }),
    payload({ peerMaterial: { ...material, privateKeyEnvelope: 'tpdaemon.' } }),
    payload({ peerMaterial: { ...material, notAfter: 'Jan 1 2027' } }),
    payload({ peerMaterial: { ...material, notAfter: '2027-01-01' } }),
  ]
  cases.forEach((bad, index) => {
    assertThrows(() => parseTunnelRoutesPayload(bad), TypeError, undefined, `case ${index}`)
  })
  // exactly at the limits is accepted
  parseTunnelRoutesPayload(payload({ routes: Array.from({ length: 2000 }, (_, i) => route(i)) }))
  parseTunnelRoutesPayload(payload({ peerAddresses: ips(64) }))
})

test('hostings[].tunnel: upper-case names and size limits are refused', () => {
  const site = ['App.example.com', 'app.example.com']
  assertThrows(() =>
    parseDeployHostingTunnel({ hostnames: ['App.example.com'], peers: ['10.0.0.5'] }, site)
  )
  const names = Array.from({ length: 257 }, (_, i) => `n${i}.example.com`)
  assertThrows(() => parseDeployHostingTunnel({ hostnames: names, peers: ['10.0.0.5'] }, names))
  const peers = Array.from({ length: 65 }, (_, i) => `10.0.0.${i + 1}`)
  assertThrows(() => parseDeployHostingTunnel({ hostnames: ['app.example.com'], peers }, site))
})

test('server.tunnel.routes: a carrier-only server may send no peer addresses', () => {
  const parsed = parseTunnelRoutesPayload(
    payload({ peerAddresses: [], listenAddresses: undefined })
  )
  assertEquals(parsed.peerAddresses, [])
  assertEquals(parsed.routes.length, 2)
})
