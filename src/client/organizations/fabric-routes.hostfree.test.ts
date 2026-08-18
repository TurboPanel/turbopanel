import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  type EndpointAddressCaches,
  type RelayRecord,
} from '../../lib/db/fabric-records.ts'
import {
  enqueueRelayPatchReconcile,
  fabricEnableErrorResponse,
  fabricNotEnabledErrorResponse,
  fabricSettingsResponse,
  fabricTypedEnqueueErrorResponse,
  gatewayRelayReadyErrorResponse,
  gatewayRolePatchErrorResponse,
  observedForRelay,
  parseFabricPutBody,
  parseRelayPatchBody,
  relayPatchUpdateFields,
  resolveRelayEndpointOrNull,
  resolveSealedRelayPresharedKey,
  toFabricRelayApiRow,
} from './fabric-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const WG_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

test('parseFabricPutBody requires a boolean enabled flag', () => {
  assertEquals(parseFabricPutBody({ enabled: true }), {
    ok: true,
    enabled: true,
  })
  assertEquals(parseFabricPutBody({ enabled: false }), {
    ok: true,
    enabled: false,
  })
  assertEquals(parseFabricPutBody({}), { ok: false, error: 'Invalid request' })
  assertEquals(parseFabricPutBody(null), {
    ok: false,
    error: 'Invalid request',
  })
})

test('parseRelayPatchBody validates role, CIDRs, keepalive, endpoint, and PSK', () => {
  assertEquals(parseRelayPatchBody({ role: 'gateway' }).ok, true)
  assertEquals(parseRelayPatchBody({ role: 'router' }).ok, false)
  assertEquals(
    parseRelayPatchBody({ advertisedCidrs: ['10.0.0.0/24'] }).ok,
    true,
  )
  assertEquals(
    parseRelayPatchBody({ advertisedCidrs: ['not-cidr'] }).ok,
    false,
  )
  assertEquals(parseRelayPatchBody({ keepalive: 25 }).ok, true)
  assertEquals(parseRelayPatchBody({ keepalive: 0 }).ok, false)
  assertEquals(parseRelayPatchBody({ keepalive: null }).ok, true)
  assertEquals(
    parseRelayPatchBody({ endpointAddress: '203.0.113.10' }).ok,
    true,
  )
  assertEquals(parseRelayPatchBody({ endpointAddress: 'not-an-ip' }).ok, false)
  assertEquals(parseRelayPatchBody({ endpointAddress: null }).ok, true)
  assertEquals(parseRelayPatchBody({ presharedKey: WG_KEY }).ok, true)
  assertEquals(parseRelayPatchBody({ presharedKey: 'short' }).ok, false)
  assertEquals(parseRelayPatchBody({ presharedKey: null }).ok, true)
})

test('parseRelayPatchBody forces advertisedCidrs empty for member role', () => {
  const parsed = parseRelayPatchBody({
    role: 'member',
    advertisedCidrs: ['10.0.0.0/24'],
  })
  assertEquals(parsed.ok, true)
  if (!parsed.ok) return
  assertEquals(parsed.patch.advertisedCidrs, [])
})

test('parseRelayPatchBody rejects non-objects and oversized advertisedCidrs', () => {
  assertEquals(parseRelayPatchBody(null), { ok: false, error: 'Invalid request' })
  assertEquals(parseRelayPatchBody([]), { ok: false, error: 'Invalid request' })
  assertEquals(
    parseRelayPatchBody({
      advertisedCidrs: Array.from({ length: 33 }, (_, i) => `10.${i}.0.0/24`),
    }).ok,
    false,
  )
  assertEquals(parseRelayPatchBody({ keepalive: 65_536 }).ok, false)
})

test('fabricSettingsResponse omits fabric when TurboFabric is off', () => {
  assertEquals(fabricSettingsResponse(null), { enabled: false, relays: [] })
  assertEquals(
    fabricSettingsResponse({
      id: 'fab-1',
      organizationId: 'org-1',
      cidr: '10.250.0.0/16',
      options: null,
    }),
    {
      enabled: true,
      fabric: { id: 'fab-1', cidr: '10.250.0.0/16', mtu: 1420 },
      relays: [],
    },
  )
})

test('fabricSettingsResponse includes relay rows without presharedKey', () => {
  const relays = [
    {
      serverId: 'srv-1',
      address: '10.250.0.1',
      role: 'member' as const,
      advertisedCidrs: [],
      resolvedAdvertisedCidrs: [],
      keepalive: null,
      endpointAddress: null,
      resolvedEndpoint: '203.0.113.10',
      publicKey: WG_KEY,
      prefix: '10.192.0.0/16',
      hasPresharedKey: true,
      segments: [],
      observed: null,
    },
    {
      serverId: 'srv-2',
      address: '10.250.0.2',
      role: 'member' as const,
      advertisedCidrs: [],
      resolvedAdvertisedCidrs: [],
      keepalive: 25,
      endpointAddress: '203.0.113.11',
      resolvedEndpoint: '203.0.113.11',
      publicKey: null,
      prefix: '10.193.0.0/16',
      hasPresharedKey: false,
      segments: [],
      observed: null,
    },
  ]
  const body = fabricSettingsResponse(
    {
      id: 'fab-1',
      organizationId: 'org-1',
      cidr: '10.250.0.0/16',
      options: { mtu: 1420 },
    },
    relays,
  )
  assertEquals(body.relays.length, 2)
  assertEquals(body.relays[0]?.hasPresharedKey, true)
  assertEquals(body.relays[1]?.hasPresharedKey, false)
  assertEquals('presharedKey' in body.relays[0]!, false)
})

test('relayPatchUpdateFields copies only provided patch keys', () => {
  assertEquals(relayPatchUpdateFields({}, undefined), {})
  assertEquals(
    relayPatchUpdateFields(
      {
        role: 'gateway',
        advertisedCidrs: ['10.0.0.0/24'],
        keepalive: 25,
        endpointAddress: '203.0.113.10',
      },
      'sealed',
    ),
    {
      role: 'gateway',
      advertisedCidrs: ['10.0.0.0/24'],
      keepalive: 25,
      endpointAddress: '203.0.113.10',
      presharedKey: 'sealed',
    },
  )
  assertEquals(
    relayPatchUpdateFields({ keepalive: null, endpointAddress: null }, null),
    { keepalive: null, endpointAddress: null, presharedKey: null },
  )
})

test('resolveSealedRelayPresharedKey omits, clears, or seals', async () => {
  const encrypt = (plaintext: string) => Promise.resolve(`sealed:${plaintext}`)
  assertEquals(
    await resolveSealedRelayPresharedKey(undefined, encrypt),
    undefined,
  )
  assertEquals(await resolveSealedRelayPresharedKey(null, encrypt), null)
  assertEquals(
    await resolveSealedRelayPresharedKey('psk', encrypt),
    'sealed:psk',
  )
  assertEquals(await resolveSealedRelayPresharedKey('psk', null), undefined)
})

test('gatewayRelayReadyErrorResponse maps gateway kinds to 422', async () => {
  assertEquals(gatewayRelayReadyErrorResponse(null), null)
  const required = gatewayRelayReadyErrorResponse({
    kind: 'gateway_datacenter_required',
    serverId: 'srv-1',
  })
  assertEquals(required?.status, 422)
  assertEquals(await required?.json(), {
    error: 'gateway_datacenter_required',
  })
  const cidr = gatewayRelayReadyErrorResponse({
    kind: 'gateway_datacenter_cidr_required',
    datacenterId: 'dc-1',
  })
  assertEquals(cidr?.status, 422)
  assertEquals(await cidr?.json(), {
    error: 'gateway_datacenter_cidr_required',
  })
})

test('gatewayRolePatchErrorResponse ignores non-gateway roles', async () => {
  assertEquals(
    gatewayRolePatchErrorResponse('member', {
      kind: 'gateway_datacenter_required',
      serverId: 'srv-1',
    }),
    null,
  )
  assertEquals(gatewayRolePatchErrorResponse('gateway', null), null)
  const denied = gatewayRolePatchErrorResponse('gateway', {
    kind: 'gateway_datacenter_required',
    serverId: 'srv-1',
  })
  assertEquals(denied?.status, 422)
  assertEquals(await denied?.json(), { error: 'gateway_datacenter_required' })
})

test('fabricTypedEnqueueErrorResponse maps typed failures to 422', async () => {
  assertEquals(
    fabricTypedEnqueueErrorResponse([{ serverId: 's1', status: 'queued' }]),
    null,
  )
  const denied = fabricTypedEnqueueErrorResponse([
    { serverId: 's1', status: 'failed', error: 'relay_missing' },
  ])
  assertEquals(denied?.status, 422)
  assertEquals(await denied?.json(), { error: 'relay_missing' })
})

test('enqueueRelayPatchReconcile skips when queue or session is missing', async () => {
  const db = {} as Db
  const commandQueue: CommandQueue = { enqueue: () => Promise.resolve() }
  let called = 0
  const reconcile = () => {
    called += 1
    return Promise.resolve([])
  }
  assertEquals(
    await enqueueRelayPatchReconcile({
      session: { userId: 'u1' },
      commandQueue: Response.json({ error: 'unavailable' }, { status: 503 }),
      db,
      organizationId: 'org-1',
      secrets: {},
      reconcile,
    }),
    null,
  )
  assertEquals(
    await enqueueRelayPatchReconcile({
      session: null,
      commandQueue,
      db,
      organizationId: 'org-1',
      secrets: {},
      reconcile,
    }),
    null,
  )
  assertEquals(called, 0)
})

test('enqueueRelayPatchReconcile returns 422 on typed enqueue errors', async () => {
  const denied = await enqueueRelayPatchReconcile({
    session: { userId: 'u1' },
    commandQueue: { enqueue: () => Promise.resolve() },
    db: {} as Db,
    organizationId: 'org-1',
    secrets: {},
    reconcile: () =>
      Promise.resolve([{
        serverId: 's1',
        status: 'failed',
        error: 'relay_missing',
      }]),
  })
  assertEquals(denied?.status, 422)
  assertEquals(await denied?.json(), { error: 'relay_missing' })
})

test('enqueueRelayPatchReconcile returns null when membership enqueue succeeds', async () => {
  assertEquals(
    await enqueueRelayPatchReconcile({
      session: { userId: 'u1' },
      commandQueue: { enqueue: () => Promise.resolve() },
      db: {} as Db,
      organizationId: 'org-1',
      secrets: {},
      reconcile: () =>
        Promise.resolve([{ serverId: 's1', status: 'queued', commandId: 'c1' }]),
    }),
    null,
  )
})

test('fabricEnableErrorResponse maps CIDR and pool exhaustion to 409', async () => {
  const cidr = fabricEnableErrorResponse(new Error('No free CIDR left in pool'))
  assertEquals(cidr.status, 409)
  assertEquals(await cidr.json(), { error: 'fabric_cidr_unavailable' })

  const pool = fabricEnableErrorResponse(new Error('address pool exhausted'))
  assertEquals(pool.status, 409)
  assertEquals(await pool.json(), { error: 'fabric_address_pool_exhausted' })

  const other = fabricEnableErrorResponse('boom')
  assertEquals(other.status, 500)
  assertEquals(await other.json(), { error: 'TurboFabric update failed' })
})

test('fabricNotEnabledErrorResponse returns stable 409', async () => {
  const res = fabricNotEnabledErrorResponse()
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'TurboFabric is not enabled' })
})

function relayRow(
  overrides: Partial<RelayRecord> & Pick<RelayRecord, 'serverId'>,
): RelayRecord {
  return {
    id: 'relay-1',
    fabricId: 'fab-1',
    address: '10.250.0.1',
    role: 'member',
    keepalive: null,
    endpointAddress: null,
    publicKey: WG_KEY,
    prefix: '10.192.0.0/16',
    advertisedCidrs: [],
    metadata: {},
    ...overrides,
  }
}

function emptyEndpointCaches(): EndpointAddressCaches {
  return {
    datacenterAddressByServer: new Map(),
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
  }
}

test('observedForRelay returns null without a public key', () => {
  assertEquals(observedForRelay([], null), null)
})

test('observedForRelay picks the newest peer observation by public key', () => {
  const otherKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
  const relays = [
    relayRow({
      serverId: 's1',
      publicKey: otherKey,
      metadata: {
        observed: {
          at: '2020-01-01T00:00:00.000Z',
          peers: [{
            publicKey: WG_KEY,
            lastHandshakeAt: '2020-01-01T00:01:00.000Z',
            transferRx: 10,
          }],
        },
      },
    }),
    relayRow({
      serverId: 's2',
      publicKey: WG_KEY,
      metadata: {
        observed: {
          at: '2020-01-02T00:00:00.000Z',
          peers: [{
            publicKey: WG_KEY,
            lastHandshakeAt: '2020-01-02T00:01:00.000Z',
            transferTx: 99,
          }],
        },
      },
    }),
  ]
  assertEquals(observedForRelay(relays, WG_KEY), {
    lastHandshakeAt: '2020-01-02T00:01:00.000Z',
    transferTx: 99,
  })
})

test('resolveRelayEndpointOrNull resolves pinned endpoints and swallows unavailable', () => {
  const pinned = relayRow({
    serverId: 's1',
    endpointAddress: '203.0.113.10',
  })
  assertEquals(
    resolveRelayEndpointOrNull(pinned, emptyEndpointCaches()),
    '203.0.113.10',
  )

  const caches: EndpointAddressCaches = {
    datacenterAddressByServer: new Map([['s2', '10.0.0.5']]),
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
  }
  assertEquals(
    resolveRelayEndpointOrNull(relayRow({ serverId: 's2' }), caches),
    '10.0.0.5',
  )

  assertEquals(
    resolveRelayEndpointOrNull(relayRow({ serverId: 's3' }), emptyEndpointCaches()),
    null,
  )
})

test('resolveRelayEndpointOrNull prefers datacenter address over public fallback', () => {
  const caches: EndpointAddressCaches = {
    datacenterAddressByServer: new Map([['s1', '10.0.0.8']]),
    publicAddressByServer: new Map([['s1', '203.0.113.20']]),
    reportedByServer: new Map(),
  }
  assertEquals(
    resolveRelayEndpointOrNull(relayRow({ serverId: 's1' }), caches),
    '10.0.0.8',
  )
})

test('toFabricRelayApiRow maps relay fields and omits presharedKey on the wire', () => {
  const relay = relayRow({
    serverId: 'srv-1',
    role: 'gateway',
    advertisedCidrs: ['10.0.0.0/24'],
    keepalive: 25,
    endpointAddress: '203.0.113.10',
    metadata: {
      observed: {
        at: '2020-01-01T00:00:00.000Z',
        peers: [{
          publicKey: WG_KEY,
          lastHandshakeAt: '2020-01-01T00:05:00.000Z',
        }],
      },
    },
  })
  const caches: EndpointAddressCaches = {
    datacenterAddressByServer: new Map(),
    publicAddressByServer: new Map([['srv-1', '198.51.100.10']]),
    reportedByServer: new Map(),
  }
  const row = toFabricRelayApiRow({
    relay,
    hasPresharedKey: true,
    segments: [{ name: 'tpn_test', subnet: '10.192.0.0/24' }],
    caches,
    relays: [relay],
    resolvedAdvertisedCidrs: ['10.0.0.0/24'],
  })
  assertEquals(row.serverId, 'srv-1')
  assertEquals(row.role, 'gateway')
  assertEquals(row.advertisedCidrs, ['10.0.0.0/24'])
  assertEquals(row.resolvedAdvertisedCidrs, ['10.0.0.0/24'])
  assertEquals(row.resolvedEndpoint, '203.0.113.10')
  assertEquals(row.hasPresharedKey, true)
  assertEquals(row.observed?.lastHandshakeAt, '2020-01-01T00:05:00.000Z')
  assertEquals('presharedKey' in row, false)
})

test('toFabricRelayApiRow emits derived resolvedAdvertisedCidrs when stored list is empty', () => {
  const relay = relayRow({
    serverId: 'srv-1',
    role: 'gateway',
    advertisedCidrs: [],
  })
  const row = toFabricRelayApiRow({
    relay,
    hasPresharedKey: false,
    segments: [],
    caches: emptyEndpointCaches(),
    relays: [relay],
    resolvedAdvertisedCidrs: ['198.51.100.0/24', '203.0.113.0/24'],
  })
  assertEquals(row.advertisedCidrs, [])
  assertEquals(row.resolvedAdvertisedCidrs, [
    '198.51.100.0/24',
    '203.0.113.0/24',
  ])
  assertEquals('presharedKey' in row, false)
})
