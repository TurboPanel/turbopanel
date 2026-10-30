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
