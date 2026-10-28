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
