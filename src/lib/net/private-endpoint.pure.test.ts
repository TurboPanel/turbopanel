import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import {
  isPrivateEndpointError,
  loadServerDatacenterAddress,
  privateEndpointErrorResponse,
  resolvePrivateEndpoint,
  resolvePrivateEndpoints,
  type PrivateEndpointError,
  type ResolvedPrivateEndpoint,
} from './private-endpoint.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type ServerRow = { id: string; datacenterId: string | null }
type IpRow = { serverId: string; address: string; createdAt: string }
type PeerRow = {
  peerId: string
  serverId: string
  vpnId: string
  vpnCreatedAt: string
  tunnelIpId: string | null
  tunnelAddress: string | null
}

type Fixture = {
  servers?: ServerRow[]
  ips?: IpRow[]
  peers?: PeerRow[]
  /** Single-row result for loadServerDatacenterAddress. */
  singleAddress?: string | null
}

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject)
    },
  }
}

function createFixtureDb(fixture: Fixture): Parameters<typeof resolvePrivateEndpoint>[0] {
  const servers = fixture.servers ?? []
  const ips = fixture.ips ?? []
  const peers = fixture.peers ?? []

  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b))
      const keySet = new Set(keys)

      // loadServerDatacenterAddress: { address }
      if (keys.length === 1 && keySet.has('address')) {
        const rows = fixture.singleAddress === undefined
          ? []
          : fixture.singleAddress === null
          ? []
          : [{ address: fixture.singleAddress }]
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return {
                      async limit() {
                        return rows
                      },
                    }
                  },
                }
              },
            }
          },
        }
      }

      // loadServerDatacenterIds: { id, datacenterId }
      if (keySet.has('id') && keySet.has('datacenterId')) {
        return {
          from() {
            return {
              where() {
                return thenable(servers)
              },
            }
          },
        }
      }

      // loadDatacenterAddresses: { serverId, address, createdAt }
      if (keySet.has('serverId') && keySet.has('address') && keySet.has('createdAt')) {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return thenable(ips)
                  },
                }
              },
            }
          },
        }
      }

      // membership: { vpnId } only
      if (keys.length === 1 && keySet.has('vpnId')) {
        return {
          from() {
            return {
              where() {
                return thenable(peers.map((row) => ({ vpnId: row.vpnId })))
              },
            }
          },
        }
      }

      // full peer join: peerId, serverId, vpnId, vpnCreatedAt, tunnelIpId, tunnelAddress
      if (keySet.has('peerId') && keySet.has('vpnCreatedAt')) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  leftJoin() {
                    return {
                      where() {
                        return {
                          orderBy() {
                            return thenable(peers)
                          },
                        }
                      },
                    }
                  },
                }
              },
            }
          },
        }
      }

      throw new TypeError(`unexpected select keys: ${keys.join(',')}`)
    },
  } as unknown as Parameters<typeof resolvePrivateEndpoint>[0]
}

function mockContext(): Context {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context
}

test('isPrivateEndpointError is a structural kind guard', () => {
  assertEquals(
    isPrivateEndpointError({ kind: 'datacenter_ip_required', serverId: 's1' }),
    true,
  )
  assertEquals(isPrivateEndpointError(null), false)
  assertEquals(isPrivateEndpointError({ address: '10.0.0.1' }), false)
})

test('privateEndpointErrorResponse returns 422 with error-only body', async () => {
  const c = mockContext()
  const errors: PrivateEndpointError[] = [
    { kind: 'datacenter_ip_required', serverId: 's1' },
    { kind: 'peer_tunnel_address_required', peerId: 'p1' },
    {
      kind: 'private_path_unavailable',
      fromServerId: 'a',
      toServerId: 'b',
    },
  ]
  for (const error of errors) {
    const response = privateEndpointErrorResponse(c, error)
    assertEquals(response.status, 422)
    assertEquals(await response.json(), { error: error.kind })
  }
})

test('loadServerDatacenterAddress returns the address string', async () => {
  const db = createFixtureDb({ singleAddress: '10.0.0.5' })
  assertEquals(await loadServerDatacenterAddress(db, 'srv-1'), '10.0.0.5')
})

test('loadServerDatacenterAddress returns null when missing', async () => {
  const db = createFixtureDb({ singleAddress: null })
  assertEquals(await loadServerDatacenterAddress(db, 'srv-1'), null)
})

test('resolvePrivateEndpoint local same-server is loopback', async () => {
  const db = createFixtureDb({
    servers: [{ id: 's1', datacenterId: 'dc-a' }],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's1',
  }), {
    address: '127.0.0.1',
    transport: 'local',
  } satisfies ResolvedPrivateEndpoint)
})

test('resolvePrivateEndpoint prefers datacenter before vpn', async () => {
  const db = createFixtureDb({
    servers: [
      { id: 's1', datacenterId: 'dc-a' },
      { id: 's2', datacenterId: 'dc-a' },
    ],
    ips: [
      { serverId: 's2', address: '10.0.0.2', createdAt: '2020-01-01T00:00:00.000Z' },
      { serverId: 's2', address: '10.0.0.9', createdAt: '2020-01-02T00:00:00.000Z' },
    ],
    peers: [
      {
        peerId: 'p1',
        serverId: 's1',
        vpnId: 'vpn-1',
        vpnCreatedAt: '2020-01-01T00:00:00.000Z',
        tunnelIpId: 't1',
        tunnelAddress: '10.8.0.1',
      },
      {
        peerId: 'p2',
        serverId: 's2',
        vpnId: 'vpn-1',
        vpnCreatedAt: '2020-01-01T00:00:00.000Z',
        tunnelIpId: 't2',
        tunnelAddress: '10.8.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    address: '10.0.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})

test('resolvePrivateEndpoint returns datacenter_ip_required when missing', async () => {
  const db = createFixtureDb({
    servers: [
      { id: 's1', datacenterId: 'dc-a' },
      { id: 's2', datacenterId: 'dc-a' },
    ],
    ips: [],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    kind: 'datacenter_ip_required',
    serverId: 's2',
  })
})

test('resolvePrivateEndpoint picks lowest vpn.createdAt when multiple meshes share', async () => {
  const db = createFixtureDb({
    servers: [
      { id: 's1', datacenterId: 'dc-a' },
      { id: 's2', datacenterId: 'dc-b' },
    ],
    peers: [
      {
        peerId: 'p-new-from',
        serverId: 's1',
        vpnId: 'vpn-new',
        vpnCreatedAt: '2021-01-01T00:00:00.000Z',
        tunnelIpId: 't2',
        tunnelAddress: '10.9.0.1',
      },
      {
        peerId: 'p-old-from',
        serverId: 's1',
        vpnId: 'vpn-old',
        vpnCreatedAt: '2020-01-01T00:00:00.000Z',
        tunnelIpId: 't1',
        tunnelAddress: '10.8.0.1',
      },
      {
        peerId: 'p-new-to',
        serverId: 's2',
        vpnId: 'vpn-new',
        vpnCreatedAt: '2021-01-01T00:00:00.000Z',
        tunnelIpId: 't4',
        tunnelAddress: '10.9.0.2',
      },
      {
        peerId: 'p-old-to',
        serverId: 's2',
        vpnId: 'vpn-old',
        vpnCreatedAt: '2020-01-01T00:00:00.000Z',
        tunnelIpId: 't3',
        tunnelAddress: '10.8.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    address: '10.8.0.2',
    transport: 'vpn',
    vpnId: 'vpn-old',
  })
})

test('resolvePrivateEndpoint returns peer_tunnel_address_required', async () => {
  const db = createFixtureDb({
    servers: [
      { id: 's1', datacenterId: 'dc-a' },
      { id: 's2', datacenterId: 'dc-b' },
    ],
    peers: [
      {
        peerId: 'p-from',
        serverId: 's1',
        vpnId: 'vpn-1',
        vpnCreatedAt: '2020-01-01T00:00:00.000Z',
        tunnelIpId: null,
        tunnelAddress: null,
      },
      {
        peerId: 'p-to',
        serverId: 's2',
        vpnId: 'vpn-1',
        vpnCreatedAt: '2020-01-01T00:00:00.000Z',
        tunnelIpId: null,
        tunnelAddress: null,
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    kind: 'peer_tunnel_address_required',
    peerId: 'p-to',
  })
})

test('resolvePrivateEndpoint returns private_path_unavailable', async () => {
  const db = createFixtureDb({
    servers: [
      { id: 's1', datacenterId: 'dc-a' },
      { id: 's2', datacenterId: 'dc-b' },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    kind: 'private_path_unavailable',
    fromServerId: 's1',
    toServerId: 's2',
  })
})

test('resolvePrivateEndpoints batches multiple targets', async () => {
  const db = createFixtureDb({
    servers: [
      { id: 's1', datacenterId: 'dc-a' },
      { id: 's2', datacenterId: 'dc-a' },
      { id: 's3', datacenterId: 'dc-a' },
    ],
    ips: [
      { serverId: 's2', address: '10.0.0.2', createdAt: '2020-01-01T00:00:00.000Z' },
      { serverId: 's3', address: '10.0.0.3', createdAt: '2020-01-01T00:00:00.000Z' },
    ],
  })
  const map = await resolvePrivateEndpoints(db, {
    fromServerId: 's1',
    toServerIds: ['s2', 's3', 's1'],
  })
  assertEquals(map.get('s1'), { address: '127.0.0.1', transport: 'local' })
  assertEquals(map.get('s2'), {
    address: '10.0.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
  assertEquals(map.get('s3'), {
    address: '10.0.0.3',
    transport: 'datacenter',
    datacenterId: 'dc-a',
  })
})
