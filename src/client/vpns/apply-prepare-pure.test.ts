import { assertEquals } from 'jsr:@std/assert'
import {
  buildAllowedIps,
  formatInterfaceAddress,
  hostRouteForTunnelAddress,
  isVpnApplyPrepareError,
  resolvePeerEndpoint,
  resolvePrimaryGatewayByDatacenter,
  validateGateways,
  type VpnApplyPrepareError,
} from './apply-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type PeerRow = Parameters<typeof resolvePrimaryGatewayByDatacenter>[0][number]
type ServerRow = {
  id: string
  datacenterId: string | null
  connected: boolean
}

function peer(
  partial: Pick<PeerRow, 'id' | 'serverId' | 'role' | 'createdAt'> &
    Partial<PeerRow>,
): PeerRow {
  return {
    endpointIpId: null,
    tunnelIpId: null,
    publicKey: null,
    listenPort: null,
    endpoint: null,
    presharedKey: null,
    ...partial,
  }
}

function servers(
  rows: ServerRow[],
): Map<string, ServerRow> {
  return new Map(rows.map((row) => [row.id, row]))
}

test('resolvePrimaryGatewayByDatacenter returns empty when no gateways exist', () => {
  const result = resolvePrimaryGatewayByDatacenter(
    [
      peer({
        id: 'p-member',
        serverId: 's1',
        role: 'member',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
    servers([{ id: 's1', datacenterId: 'dc-a', connected: true }]),
  )
  assertEquals(result.size, 0)
})

test('resolvePrimaryGatewayByDatacenter skips gateways without a datacenter', () => {
  const result = resolvePrimaryGatewayByDatacenter(
    [
      peer({
        id: 'p-gw',
        serverId: 's1',
        role: 'gateway',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
    servers([{ id: 's1', datacenterId: null, connected: true }]),
  )
  assertEquals(result.size, 0)
})

test('resolvePrimaryGatewayByDatacenter prefers the earliest online gateway', () => {
  const result = resolvePrimaryGatewayByDatacenter(
    [
      peer({
        id: 'p-offline-early',
        serverId: 's-offline',
        role: 'gateway',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
      peer({
        id: 'p-online-late',
        serverId: 's-online',
        role: 'gateway',
        createdAt: '2020-01-02T00:00:00.000Z',
      }),
      peer({
        id: 'p-online-early',
        serverId: 's-online-2',
        role: 'gateway',
        createdAt: '2020-01-01T12:00:00.000Z',
      }),
    ],
    servers([
      { id: 's-offline', datacenterId: 'dc-a', connected: false },
      { id: 's-online', datacenterId: 'dc-a', connected: true },
      { id: 's-online-2', datacenterId: 'dc-a', connected: true },
    ]),
  )
  assertEquals(result.get('dc-a'), 'p-online-early')
})

test('resolvePrimaryGatewayByDatacenter falls back to earliest gateway when all offline', () => {
  const result = resolvePrimaryGatewayByDatacenter(
    [
      peer({
        id: 'p-late',
        serverId: 's2',
        role: 'gateway',
        createdAt: '2020-01-02T00:00:00.000Z',
      }),
      peer({
        id: 'p-early',
        serverId: 's1',
        role: 'gateway',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
    servers([
      { id: 's1', datacenterId: 'dc-a', connected: false },
      { id: 's2', datacenterId: 'dc-a', connected: false },
    ]),
  )
  assertEquals(result.get('dc-a'), 'p-early')
})

test('resolvePrimaryGatewayByDatacenter picks one primary per datacenter', () => {
  const result = resolvePrimaryGatewayByDatacenter(
    [
      peer({
        id: 'p-a',
        serverId: 's-a',
        role: 'gateway',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
      peer({
        id: 'p-b',
        serverId: 's-b',
        role: 'gateway',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
    servers([
      { id: 's-a', datacenterId: 'dc-a', connected: true },
      { id: 's-b', datacenterId: 'dc-b', connected: true },
    ]),
  )
  assertEquals(result.get('dc-a'), 'p-a')
  assertEquals(result.get('dc-b'), 'p-b')
  assertEquals(result.size, 2)
})

test('resolvePrimaryGatewayByDatacenter ignores unknown server ids', () => {
  const result = resolvePrimaryGatewayByDatacenter(
    [
      peer({
        id: 'p-orphan',
        serverId: 'missing',
        role: 'gateway',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
    ],
    servers([]),
  )
  assertEquals(result.size, 0)
})

test('isVpnApplyPrepareError recognizes every prepare error kind', () => {
  const errors: VpnApplyPrepareError[] = [
    { kind: 'peer_tunnel_address_required', peerId: 'p1' },
    { kind: 'vpn_has_no_peers' },
    { kind: 'daemon_key_unavailable', serverId: 's1' },
    { kind: 'gateway_datacenter_required', peerId: 'p1', serverId: 's1' },
    {
      kind: 'gateway_datacenter_cidr_required',
      peerId: 'p1',
      datacenterId: 'dc1',
    },
  ]
  for (const error of errors) {
    assertEquals(isVpnApplyPrepareError(error), true)
  }
  assertEquals(isVpnApplyPrepareError({ vpnId: 'v1', peers: [] }), false)
  assertEquals(isVpnApplyPrepareError(null), false)
})

test('hostRouteForTunnelAddress uses host prefix lengths', () => {
  assertEquals(hostRouteForTunnelAddress('203.0.113.5'), '203.0.113.5/32')
  assertEquals(hostRouteForTunnelAddress('2001:db8::5'), '2001:db8::5/128')
})

test('formatInterfaceAddress prefers VPN CIDR prefix length', () => {
  assertEquals(
    formatInterfaceAddress('203.0.113.5', '203.0.113.0/24'),
    '203.0.113.5/24',
  )
  assertEquals(
    formatInterfaceAddress('2001:db8::5', '2001:db8::/64'),
    '2001:db8::5/64',
  )
  assertEquals(
    formatInterfaceAddress('203.0.113.5', 'not-a-cidr'),
    '203.0.113.5/32',
  )
})

test('resolvePeerEndpoint prefers explicit endpoint over derived address', () => {
  assertEquals(
    resolvePeerEndpoint({
      endpoint: '203.0.113.10:51820',
      listenPort: 51821,
      ipAddress: '203.0.113.11',
    }),
    '203.0.113.10:51820',
  )
  assertEquals(
    resolvePeerEndpoint({
      endpoint: null,
      listenPort: 51820,
      ipAddress: '203.0.113.10',
    }),
    '203.0.113.10:51820',
  )
  assertEquals(
    resolvePeerEndpoint({
      endpoint: null,
      listenPort: 51820,
      ipAddress: '2001:db8::1',
    }),
    '[2001:db8::1]:51820',
  )
  assertEquals(
    resolvePeerEndpoint({ endpoint: null, listenPort: null, ipAddress: null }),
    undefined,
  )
})

test('validateGateways requires datacenter and CIDR network for gateways', () => {
  const peerRows = [
    peer({
      id: 'p-gw',
      serverId: 's-gw',
      role: 'gateway',
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
    peer({
      id: 'p-member',
      serverId: 's-member',
      role: 'member',
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
  ]
  const serversById = servers([
    { id: 's-gw', datacenterId: null, connected: true },
    { id: 's-member', datacenterId: 'dc-a', connected: true },
  ])

  assertEquals(
    validateGateways(peerRows, serversById, new Map()),
    {
      kind: 'gateway_datacenter_required',
      peerId: 'p-gw',
      serverId: 's-gw',
    },
  )

  const withDc = servers([
    { id: 's-gw', datacenterId: 'dc-a', connected: true },
    { id: 's-member', datacenterId: 'dc-a', connected: true },
  ])
  assertEquals(
    validateGateways(peerRows, withDc, new Map([['dc-a', []]])),
    {
      kind: 'gateway_datacenter_cidr_required',
      peerId: 'p-gw',
      datacenterId: 'dc-a',
    },
  )

  const cidrsByDc = new Map([['dc-a', ['10.0.0.0/24']]])
  assertEquals(validateGateways(peerRows, withDc, cidrsByDc), null)
})

test('buildAllowedIps advertises site CIDR only for primary remote gateway', () => {
  const other = peer({
    id: 'p-gw',
    serverId: 's-gw',
    role: 'gateway',
    createdAt: '2020-01-01T00:00:00.000Z',
  })
  const hostRoute = '203.0.113.2/32'
  const serversById = servers([
    { id: 's-gw', datacenterId: 'dc-a', connected: true },
  ])
  const siteCidrsByDc = new Map([['dc-a', ['10.0.0.0/24', '10.0.1.0/24']]])

  assertEquals(
    buildAllowedIps({
      other: peer({
        id: 'p-member',
        serverId: 's-member',
        role: 'member',
        createdAt: '2020-01-01T00:00:00.000Z',
      }),
      hostRoute,
      targetDatacenterId: 'dc-b',
      primaryGatewayByDc: new Map(),
      siteCidrsByDc,
      serversById,
    }),
    [hostRoute],
  )

  assertEquals(
    buildAllowedIps({
      other,
      hostRoute,
      targetDatacenterId: 'dc-b',
      primaryGatewayByDc: new Map([['dc-a', 'p-gw']]),
      siteCidrsByDc,
      serversById,
    }).sort((a, b) => a.localeCompare(b)),
    [hostRoute, '10.0.0.0/24', '10.0.1.0/24'].sort((a, b) => a.localeCompare(b)),
  )

  assertEquals(
    buildAllowedIps({
      other,
      hostRoute,
      targetDatacenterId: 'dc-a',
      primaryGatewayByDc: new Map([['dc-a', 'p-gw']]),
      siteCidrsByDc,
      serversById,
    }),
    [hostRoute],
  )

  assertEquals(
    buildAllowedIps({
      other,
      hostRoute,
      targetDatacenterId: 'dc-b',
      primaryGatewayByDc: new Map([['dc-a', 'p-standby']]),
      siteCidrsByDc,
      serversById,
    }),
    [hostRoute],
  )
})
