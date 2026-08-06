import { assertEquals } from 'jsr:@std/assert'
import { resolvePrimaryGatewayByDatacenter } from './apply-prepare.ts'

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
