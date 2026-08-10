import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  applyVpnJsonbPatchFields,
  assertMutuallyExclusiveTunnelSelection,
  assignPatchEndpoint,
  assignPatchJsonbField,
  assignPatchListenPort,
  assignPatchPublicKey,
  assignPatchRole,
  isAutoAllocateTunnel,
  isPeerUniqueViolation,
  isPostgresUniqueViolation,
  isVpnCidrUniqueViolation,
  mapExplicitTunnelAddressConflict,
  parseCreateOptionalEndpoint,
  parseCreateOptionalListenPort,
  parseOptionalPublicKey,
  parseOptionalScopeUuid,
  parseOptionalTunnelAddress,
  parseOptionalVpnCidrPatch,
  parsePatchEndpoint,
  parsePatchListenPort,
  parsePeerRole,
  parseRequiredPublicKey,
  parseRequiredVpnCidr,
  peerUniqueConflictError,
  peerUniqueConflictResponse,
  shouldReleaseTunnelOnPatch,
  type PeerPatchFields,
  type VpnPatchFields,
} from './routes-pure.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const VALID_WG_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='

function mockContext(): Context<AppEnv> {
  return {
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

async function expectInvalidRequest(response: unknown): Promise<void> {
  if (!(response instanceof Response)) {
    throw new TypeError('expected invalid request response')
  }
  assertEquals(response.status, 400)
  assertEquals(await response.json(), { error: 'Invalid request' })
}

test('postgres unique violation helpers classify VPN and peer indexes', () => {
  const base = Object.assign(new Error('duplicate'), { code: '23505' })
  assertEquals(isPostgresUniqueViolation(base), true)
  assertEquals(isPostgresUniqueViolation({ code: '23503' }), false)

  const vpnCidr = Object.assign(
    new Error('uniq_vpn_organization_id_cidr'),
    { code: '23505' },
  )
  assertEquals(isVpnCidrUniqueViolation(vpnCidr), true)
  assertEquals(isVpnCidrUniqueViolation(base), false)

  const serverConflict = Object.assign(
    new Error('peer_vpn_server_unique'),
    { code: '23505' },
  )
  const keyConflict = Object.assign(
    new Error('peer_vpn_public_key_unique'),
    { code: '23505' },
  )
  const tunnelConflict = Object.assign(
    new Error('uniq_peer_vpn_tunnel_ip'),
    { code: '23505' },
  )
  assertEquals(isPeerUniqueViolation(serverConflict), 'server')
  assertEquals(isPeerUniqueViolation(keyConflict), 'public_key')
  assertEquals(isPeerUniqueViolation(tunnelConflict), 'tunnel_ip')
  assertEquals(peerUniqueConflictError(serverConflict), 'peer_server_conflict')
  assertEquals(peerUniqueConflictError(keyConflict), 'peer_public_key_conflict')
  assertEquals(peerUniqueConflictError(tunnelConflict), 'peer_tunnel_ip_conflict')
})

test('peerUniqueConflictResponse maps known violations to 409 JSON', async () => {
  const c = mockContext()
  const err = Object.assign(new Error('peer_vpn_server_unique'), { code: '23505' })
  const response = peerUniqueConflictResponse(c, err)
  if (!response) throw new TypeError('expected conflict response')
  assertEquals(response.status, 409)
  assertEquals(await response.json(), { error: 'peer_server_conflict' })
  assertEquals(peerUniqueConflictResponse(c, new Error('other')), null)
})

test('parseRequiredVpnCidr and parseOptionalVpnCidrPatch validate CIDR strings', async () => {
  const c = mockContext()
  assertEquals(parseRequiredVpnCidr(c, { cidr: ' 203.0.113.0/24 ' }), '203.0.113.0/24')
  await expectInvalidRequest(parseRequiredVpnCidr(c, {}))
  await expectInvalidRequest(parseRequiredVpnCidr(c, { cidr: 'not-a-cidr' }))
  await expectInvalidRequest(parseRequiredVpnCidr(c, { cidr: '   ' }))

  assertEquals(parseOptionalVpnCidrPatch(c, {}), undefined)
  assertEquals(parseOptionalVpnCidrPatch(c, { cidr: '10.0.0.0/8' }), '10.0.0.0/8')
  await expectInvalidRequest(parseOptionalVpnCidrPatch(c, { cidr: 42 }))
})

test('applyVpnJsonbPatchFields merges metadata and options', async () => {
  const c = mockContext()
  const patchFields: VpnPatchFields = { updatedAt: '2020-01-01T00:00:00.000Z' }
  assertEquals(applyVpnJsonbPatchFields(c, { metadata: { a: 1 } }, patchFields), null)
  assertEquals(patchFields.metadata, { a: 1 })
  assertEquals(applyVpnJsonbPatchFields(c, { options: { b: 2 } }, patchFields), null)
  assertEquals(patchFields.options, { b: 2 })
})

test('parseOptionalTunnelAddress strips inet suffix and validates IPs', async () => {
  const c = mockContext()
  assertEquals(parseOptionalTunnelAddress(c, undefined), undefined)
  assertEquals(parseOptionalTunnelAddress(c, '203.0.113.5/32'), '203.0.113.5')
  await expectInvalidRequest(parseOptionalTunnelAddress(c, 1))
  await expectInvalidRequest(parseOptionalTunnelAddress(c, 'not-an-ip'))
})

test('parsePeerRole accepts gateway and member only', async () => {
  const c = mockContext()
  assertEquals(parsePeerRole(c, undefined, false), undefined)
  await expectInvalidRequest(parsePeerRole(c, undefined, true))
  assertEquals(parsePeerRole(c, 'gateway', true), 'gateway')
  assertEquals(parsePeerRole(c, 'member', false), 'member')
  await expectInvalidRequest(parsePeerRole(c, 'admin', true))
})

test('parseOptionalPublicKey and parseRequiredPublicKey validate WireGuard keys', async () => {
  const c = mockContext()
  assertEquals(parseOptionalPublicKey(c, undefined), null)
  assertEquals(parseOptionalPublicKey(c, `  ${VALID_WG_KEY}  `), VALID_WG_KEY)
  const badKey = await parseOptionalPublicKey(c, 'bad-key')
  if (!(badKey instanceof Response)) throw new TypeError('expected response')
  assertEquals(badKey.status, 400)
  assertEquals(await badKey.json(), { error: 'Invalid WireGuard public key' })
  await expectInvalidRequest(parseOptionalPublicKey(c, ''))

  assertEquals(parseRequiredPublicKey(c, VALID_WG_KEY), VALID_WG_KEY)
  await expectInvalidRequest(parseRequiredPublicKey(c, null))
  const invalid = await parseRequiredPublicKey(c, 'bad-key')
  if (!(invalid instanceof Response)) throw new TypeError('expected response')
  assertEquals(invalid.status, 400)
  assertEquals(await invalid.json(), { error: 'Invalid WireGuard public key' })
})

test('parseCreateOptionalListenPort defaults and bounds ports', async () => {
  const c = mockContext()
  assertEquals(parseCreateOptionalListenPort(c, undefined), 51820)
  assertEquals(parseCreateOptionalListenPort(c, null), 51820)
  assertEquals(parseCreateOptionalListenPort(c, 12345), 12345)
  await expectInvalidRequest(parseCreateOptionalListenPort(c, 0))
  await expectInvalidRequest(parseCreateOptionalListenPort(c, 70_000))
  await expectInvalidRequest(parseCreateOptionalListenPort(c, 1.5))
})

test('parseCreateOptionalEndpoint and parsePatchEndpoint normalize endpoints', async () => {
  const c = mockContext()
  assertEquals(parseCreateOptionalEndpoint(c, undefined), null)
  assertEquals(parseCreateOptionalEndpoint(c, ' 203.0.113.10:51820 '), '203.0.113.10:51820')
  assertEquals(parseCreateOptionalEndpoint(c, '   '), null)
  await expectInvalidRequest(parseCreateOptionalEndpoint(c, 123))

  assertEquals(parsePatchEndpoint(c, null), null)
  assertEquals(parsePatchEndpoint(c, ' host.example '), 'host.example')
  assertEquals(parsePatchEndpoint(c, ' '), null)
  await expectInvalidRequest(parsePatchEndpoint(c, 42))
})

test('parsePatchListenPort accepts null or integer listen ports', async () => {
  const c = mockContext()
  assertEquals(parsePatchListenPort(c, null), null)
  assertEquals(parsePatchListenPort(c, 51820), 51820)
  await expectInvalidRequest(parsePatchListenPort(c, '51820'))
})

test('tunnel selection helpers enforce exclusivity and auto-allocate detection', async () => {
  const c = mockContext()
  assertEquals(assertMutuallyExclusiveTunnelSelection(c, '203.0.113.2', undefined), null)
  await expectInvalidRequest(
    assertMutuallyExclusiveTunnelSelection(c, '203.0.113.2', '550e8400-e29b-41d4-a716-446655440000'),
  )
  assertEquals(isAutoAllocateTunnel(undefined, undefined), true)
  assertEquals(isAutoAllocateTunnel('550e8400-e29b-41d4-a716-446655440000', undefined), false)
  assertEquals(isAutoAllocateTunnel(undefined, '203.0.113.2'), false)
})

test('shouldReleaseTunnelOnPatch detects tunnel row replacement', () => {
  assertEquals(shouldReleaseTunnelOnPatch('ip-old', 'ip-new'), true)
  assertEquals(shouldReleaseTunnelOnPatch('ip-old', 'ip-old'), false)
  assertEquals(shouldReleaseTunnelOnPatch(null, 'ip-new'), false)
  assertEquals(shouldReleaseTunnelOnPatch('ip-old', undefined), false)
})

test('assignPatch* helpers populate peer patch fields', async () => {
  const c = mockContext()
  const patch: PeerPatchFields = { updatedAt: '2020-01-01T00:00:00.000Z' }

  assertEquals(assignPatchPublicKey(c, { publicKey: VALID_WG_KEY }, patch), null)
  assertEquals(patch.publicKey, VALID_WG_KEY)

  assertEquals(assignPatchRole(c, { role: 'gateway' }, patch), null)
  assertEquals(patch.role, 'gateway')

  assertEquals(assignPatchListenPort(c, { listenPort: 51999 }, patch), null)
  assertEquals(patch.listenPort, 51999)

  assertEquals(assignPatchEndpoint(c, { endpoint: '203.0.113.10' }, patch), null)
  assertEquals(patch.endpoint, '203.0.113.10')

  assertEquals(assignPatchJsonbField(c, { metadata: { x: 1 } }, 'metadata', patch), null)
  assertEquals(patch.metadata, { x: 1 })
})

test('parseOptionalScopeUuid validates UUID-shaped scope ids', async () => {
  const c = mockContext()
  const valid = '550e8400-e29b-41d4-a716-446655440000'
  assertEquals(parseOptionalScopeUuid(c, undefined), undefined)
  assertEquals(parseOptionalScopeUuid(c, null), null)
  assertEquals(parseOptionalScopeUuid(c, valid), valid)
  await expectInvalidRequest(parseOptionalScopeUuid(c, 'not-a-uuid'))
})

test('mapExplicitTunnelAddressConflict returns vpn_address_conflict for explicit addresses', () => {
  assertEquals(mapExplicitTunnelAddressConflict(true), {
    ok: false,
    status: 409,
    error: 'vpn_address_conflict',
  })
  assertEquals(mapExplicitTunnelAddressConflict(false), null)
})
