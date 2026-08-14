import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  enqueueRelayPatchReconcile,
  fabricSettingsResponse,
  fabricTypedEnqueueErrorResponse,
  gatewayRelayReadyErrorResponse,
  gatewayRolePatchErrorResponse,
  parseFabricPutBody,
  parseRelayPatchBody,
  relayPatchUpdateFields,
  resolveSealedRelayPresharedKey,
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
