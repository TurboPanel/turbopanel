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

type MembershipPinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
}
type RelayRow = {
  relayId: string
  serverId: string
  fabricId: string
  fabricCreatedAt: string
  address: string
}

function membershipPin(
  serverId: string,
  datacenterId: string,
  address: string,
): MembershipPinRow {
  return {
    ipId: `ip-${serverId}-${datacenterId}`,
    serverId,
    datacenterId,
    networkId: null,
    address,
  }
}

type Fixture = {
  memberships?: MembershipPinRow[]
  relays?: RelayRow[]
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
  const memberships = fixture.memberships ?? []
  const relays = fixture.relays ?? []

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

      // loadDatacenterMembershipsForServers: { ipId, serverId, datacenterId, networkId, address }
      if (
        keySet.has('ipId') &&
        keySet.has('serverId') &&
        keySet.has('datacenterId') &&
        keySet.has('networkId') &&
        keySet.has('address')
      ) {
        return {
          from() {
            return {
              where() {
                return thenable(memberships)
              },
            }
          },
        }
      }

      // membership: { fabricId } only
      if (keys.length === 1 && keySet.has('fabricId')) {
        return {
          from() {
            return {
              where() {
                return thenable(relays.map((row) => ({ fabricId: row.fabricId })))
              },
            }
          },
        }
      }

      // full relay join: relayId, serverId, fabricId, fabricCreatedAt, address
      if (keySet.has('relayId') && keySet.has('fabricCreatedAt')) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  where() {
                    return {
                      orderBy() {
                        return thenable(relays)
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
    memberships: [membershipPin('s1', 'dc-a', '10.0.0.1')],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's1',
  }), {
    address: '127.0.0.1',
    transport: 'local',
  } satisfies ResolvedPrivateEndpoint)
})

test('resolvePrivateEndpoint prefers fabric when both paths exist', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.2'),
    ],
    relays: [
      {
        relayId: 'r1',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r2',
        serverId: 's2',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    address: '10.250.0.2',
    transport: 'fabric',
    fabricId: 'fabric-1',
  })
})

test('resolvePrivateEndpoint prefers fabric over datacenter_ip_required', async () => {
  const db = createFixtureDb({
    memberships: [],
    relays: [
      {
        relayId: 'r1',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r2',
        serverId: 's2',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    address: '10.250.0.2',
    transport: 'fabric',
    fabricId: 'fabric-1',
  })
})

test('resolvePrivateEndpoint falls back to datacenter when there is no shared fabric', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.2'),
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

test('resolvePrivateEndpoint returns private_path_unavailable when membership pins have no address', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', ''),
      membershipPin('s2', 'dc-a', ''),
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

test('resolvePrivateEndpoint picks lowest fabric.createdAt when multiple meshes share', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
    ],
    relays: [
      {
        relayId: 'r-new-from',
        serverId: 's1',
        fabricId: 'fabric-new',
        fabricCreatedAt: '2021-01-01T00:00:00.000Z',
        address: '10.251.0.1',
      },
      {
        relayId: 'r-old-from',
        serverId: 's1',
        fabricId: 'fabric-old',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
      {
        relayId: 'r-new-to',
        serverId: 's2',
        fabricId: 'fabric-new',
        fabricCreatedAt: '2021-01-01T00:00:00.000Z',
        address: '10.251.0.2',
      },
      {
        relayId: 'r-old-to',
        serverId: 's2',
        fabricId: 'fabric-old',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.2',
      },
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    address: '10.250.0.2',
    transport: 'fabric',
    fabricId: 'fabric-old',
  })
})

test('resolvePrivateEndpoint returns private_path_unavailable when the target has no relay', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
    ],
    relays: [
      {
        relayId: 'r-from',
        serverId: 's1',
        fabricId: 'fabric-1',
        fabricCreatedAt: '2020-01-01T00:00:00.000Z',
        address: '10.250.0.1',
      },
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

test('resolvePrivateEndpoint returns private_path_unavailable', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
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
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s2', 'dc-a', '10.0.0.2'),
      membershipPin('s3', 'dc-a', '10.0.0.3'),
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

test('resolvePrivateEndpoints returns empty map for empty target list', async () => {
  const db = createFixtureDb({})
  const map = await resolvePrivateEndpoints(db, {
    fromServerId: 's1',
    toServerIds: [],
  })
  assertEquals(map.size, 0)
})

test('resolvePrivateEndpoint uses a shared membership when servers pin into many datacenters', async () => {
  const db = createFixtureDb({
    memberships: [
      membershipPin('s1', 'dc-a', '10.0.0.1'),
      membershipPin('s1', 'dc-b', '10.1.0.1'),
      membershipPin('s2', 'dc-b', '10.1.0.2'),
      membershipPin('s2', 'dc-c', '10.2.0.2'),
    ],
  })
  assertEquals(await resolvePrivateEndpoint(db, {
    fromServerId: 's1',
    toServerId: 's2',
  }), {
    address: '10.1.0.2',
    transport: 'datacenter',
    datacenterId: 'dc-b',
  })
})
