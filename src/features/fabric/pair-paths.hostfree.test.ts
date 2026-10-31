import { assertEquals } from '@std/assert'
import type { FabricRecord, RelayRecord } from './fabric-records.ts'
import { describeFabricPair } from './pair-paths.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const FABRIC: FabricRecord = {
  id: 'fab-1',
  organizationId: 'org-1',
  cidr: '10.250.0.0/16',
  options: {},
  enabled: true,
}

function relayRow(n: number, endpointAddress: string | null): RelayRecord {
  return {
    id: `r${n}`,
    fabricId: FABRIC.id,
    serverId: `srv-${n}`,
    address: `10.250.0.${n}`,
    role: 'member',
    keepalive: null,
    endpointAddress,
    publicKey: `${String(n).repeat(43)}=`,
    prefix: `10.19${n}.0.0/16`,
    advertisedCidrs: [],
    metadata: {},
    allowRelay: null,
    preferredGatewayIds: [],
  }
}

function context(relays: RelayRecord[]): Parameters<typeof describeFabricPair>[0] {
  return {
    fabric: FABRIC,
    relayByServer: new Map(relays.map((row) => [row.serverId, row])),
    gateways: [],
    caches: {
      publicAddressByServer: new Map(),
      reportedByServer: new Map(),
      datacenterMembershipsByServer: new Map(),
      policyByDatacenter: new Map(),
      natEndpointByPair: new Map(),
      failedPathKindsByPair: new Map(),
    },
    names: new Map(),
    datacenterNames: new Map(),
  }
}

test('a public server and a NAT-only server have a TurboFabric path in either order', () => {
  const ctx = context([relayRow(1, '203.0.113.10'), relayRow(2, null)])
  assertEquals(describeFabricPair(ctx, 'srv-1', 'srv-2').path, 'fabric')
  assertEquals(describeFabricPair(ctx, 'srv-2', 'srv-1').path, 'fabric')
})

test('two NAT-only servers with no gateway have no path', () => {
  const ctx = context([relayRow(1, null), relayRow(2, null)])
  assertEquals(describeFabricPair(ctx, 'srv-1', 'srv-2').path, 'none')
})

function reported(
  row: RelayRecord,
  peer: RelayRecord,
  at: string,
  handshake?: string
): RelayRecord {
  return {
    ...row,
    metadata: {
      observed: {
        at,
        peers: [
          { publicKey: peer.publicKey!, ...(handshake ? { lastHandshakeAt: handshake } : {}) },
        ],
      },
    },
  }
}

test("a tunnel pair carries each end's own reading about the other end", () => {
  const pub = relayRow(1, '203.0.113.10')
  const nat = relayRow(2, null)
  const ctx = context([
    reported(pub, nat, '2026-10-31T10:00:00.000Z'),
    reported(nat, pub, '2026-10-31T10:00:05.000Z', '2026-10-31T09:59:30.000Z'),
  ])
  assertEquals(describeFabricPair(ctx, 'srv-1', 'srv-2').tunnel, {
    readings: [
      { reporterServerId: 'srv-1', observedAt: '2026-10-31T10:00:00.000Z' },
      {
        reporterServerId: 'srv-2',
        observedAt: '2026-10-31T10:00:05.000Z',
        lastHandshakeAt: '2026-10-31T09:59:30.000Z',
      },
    ],
  })
})

test('a pair with no report from either end has no tunnel field', () => {
  const ctx = context([relayRow(1, '203.0.113.10'), relayRow(2, null)])
  assertEquals('tunnel' in describeFabricPair(ctx, 'srv-1', 'srv-2'), false)
})

test('a pair with no tunnel (paused mesh) carries no readings even when reports are stored', () => {
  const pub = relayRow(1, '203.0.113.10')
  const nat = relayRow(2, null)
  const ctx = {
    ...context([reported(pub, nat, '2026-10-31T10:00:00.000Z', '2026-10-31T09:59:50.000Z'), nat]),
    fabric: { ...FABRIC, enabled: false },
  }
  const row = describeFabricPair(ctx, 'srv-1', 'srv-2')
  assertEquals(row.path, 'none')
  assertEquals('tunnel' in row, false)
})

test('a reporter that does not list the other end as a peer gives no reading', () => {
  const a = relayRow(1, '203.0.113.10')
  const b = relayRow(2, null)
  const c = relayRow(3, null)
  const ctx = context([reported(a, c, '2026-10-31T10:00:00.000Z'), b])
  assertEquals('tunnel' in describeFabricPair(ctx, 'srv-1', 'srv-2'), false)
})
