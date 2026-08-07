import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import { deriveWireguardInterfaceName } from '../../lib/commands/wireguard.ts'
import { prepareVpnApplyPayloads } from './apply-prepare.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const VPN_ID = '550e8400-e29b-41d4-a716-446655440000'

function whereResult(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: async () => rows,
  })
}

function createSequentialSelectDb(...resultSets: unknown[][]): Db {
  let index = 0
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return whereResult(resultSets[index++] ?? [])
            },
          }
        },
      }
    },
  } as unknown as Db
}

test('prepareVpnApplyPayloads returns vpn_has_no_peers when VPN row is missing', async () => {
  const db = createSequentialSelectDb([])
  const result = await prepareVpnApplyPayloads(db, VPN_ID)
  assertEquals(result, { kind: 'vpn_has_no_peers' })
})

test('prepareVpnApplyPayloads returns vpn_has_no_peers when peer list is empty', async () => {
  const db = createSequentialSelectDb(
    [{ id: VPN_ID, cidr: '203.0.113.0/24' }],
    [],
  )
  const result = await prepareVpnApplyPayloads(db, VPN_ID)
  assertEquals(result, { kind: 'vpn_has_no_peers' })
})

test('prepareVpnApplyPayloads builds mesh payloads with forwarding on primary gateway', async () => {
  const peerRows = [
    {
      id: 'peer-gw',
      serverId: 'server-gw',
      endpointIpId: null,
      tunnelIpId: 'ip-gw',
      role: 'gateway',
      publicKey: WG_PUBKEY,
      listenPort: 51820,
      endpoint: null,
      presharedKey: null,
      createdAt: '2020-01-01T00:00:00.000Z',
    },
    {
      id: 'peer-member',
      serverId: 'server-member',
      endpointIpId: null,
      tunnelIpId: 'ip-member',
      role: 'member',
      publicKey: WG_PUBKEY,
      listenPort: 51820,
      endpoint: null,
      presharedKey: null,
      createdAt: '2020-01-02T00:00:00.000Z',
    },
  ]
  const serverRows = [
    { id: 'server-gw', datacenterId: 'dc-a', connected: true },
    { id: 'server-member', datacenterId: 'dc-b', connected: true },
  ]
  const networkRows = [{ datacenterId: 'dc-a', cidr: '10.0.0.0/24' }]
  const ipRows = [
    { id: 'ip-gw', address: '203.0.113.1' },
    { id: 'ip-member', address: '203.0.113.2' },
  ]

  const db = createSequentialSelectDb(
    [{ id: VPN_ID, cidr: '203.0.113.0/24' }],
    peerRows,
    serverRows,
    networkRows,
    ipRows,
  )

  const result = await prepareVpnApplyPayloads(db, VPN_ID)
  if ('kind' in result) {
    throw new TypeError('expected prepared VPN apply payloads')
  }

  assertEquals(result.interfaceName, deriveWireguardInterfaceName(VPN_ID))
  assertEquals(result.payloads.length, 2)

  const gatewayPayload = result.payloads.find((entry) =>
    entry.payload.peerId === 'peer-gw'
  )?.payload
  const memberPayload = result.payloads.find((entry) =>
    entry.payload.peerId === 'peer-member'
  )?.payload

  if (!gatewayPayload || !memberPayload) {
    throw new TypeError('expected gateway and member payloads')
  }

  assertEquals(gatewayPayload.enableIpForwarding, true)
  assertEquals(gatewayPayload.address, '203.0.113.1/24')
  assertEquals(gatewayPayload.listenPort, 51820)

  const remotePeer = gatewayPayload.peers.find((entry) => entry.peerId === 'peer-member')
  assertEquals(remotePeer?.allowedIps, ['203.0.113.2/32'])

  const memberRemotePeer = memberPayload.peers.find((entry) =>
    entry.peerId === 'peer-gw'
  )
  assertEquals(memberRemotePeer?.allowedIps?.includes('10.0.0.0/24'), true)
  assertEquals(memberPayload.enableIpForwarding, undefined)
})

test('prepareVpnApplyPayloads returns peer_tunnel_address_required when tunnel IP missing', async () => {
  const peerRows = [
    {
      id: 'peer-a',
      serverId: 'server-a',
      endpointIpId: null,
      tunnelIpId: null,
      role: 'member',
      publicKey: WG_PUBKEY,
      listenPort: null,
      endpoint: null,
      presharedKey: null,
      createdAt: '2020-01-01T00:00:00.000Z',
    },
  ]
  const db = createSequentialSelectDb(
    [{ id: VPN_ID, cidr: '203.0.113.0/24' }],
    peerRows,
    [{ id: 'server-a', datacenterId: 'dc-a', connected: true }],
    [],
    [],
  )

  const result = await prepareVpnApplyPayloads(db, VPN_ID)
  assertEquals(result, {
    kind: 'peer_tunnel_address_required',
    peerId: 'peer-a',
  })
})
