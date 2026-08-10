import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import { ip, peer, vpn } from '../../lib/db/schema.ts'
import { stripInetPrefixSuffix } from '../../lib/ip-address.ts'
import {
  allocateVpnTunnelIpOnce,
  createVpnTunnelIpAtOnce,
  isAddressInVpnCidr,
  isVpnAddressUniqueViolation,
  releaseVpnTunnelIpIfOrphaned,
} from '../../lib/net/vpn-address-allocator.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import {
  enqueuePreparedVpnApply,
  prepareVpnApplyPayloads,
  type VpnApplyPrepareError,
  type VpnApplyResealDeps,
} from './apply-prepare.ts'
import {
  assertCanCreateOr403,
  assertCanManageOr403,
  assertCanReadOr403,
  buildPatchUpdateFields,
  getOrgId,
  parseDisplayName,
  parseJsonBody,
  parseJsonbObject,
} from '../shared.ts'
import {
  applyVpnJsonbPatchFields,
  assignPatchEndpoint,
  assignPatchJsonbField,
  assignPatchListenPort,
  assignPatchPublicKey,
  assignPatchRole,
  assertMutuallyExclusiveTunnelSelection,
  isAutoAllocateTunnel,
  isVpnCidrUniqueViolation,
  mapExplicitTunnelAddressConflict,
  parseCreateOptionalEndpoint,
  parseCreateOptionalListenPort,
  parseOptionalPublicKey,
  parseOptionalScopeUuid,
  parseOptionalTunnelAddress,
  parseOptionalVpnCidrPatch,
  parsePeerRole,
  parseRequiredVpnCidr,
  peerUniqueConflictError,
  peerUniqueConflictResponse,
  shouldReleaseTunnelOnPatch,
  type OptionalStringResult,
  type PeerPatchFields,
  type VpnPatchFields,
  UUID_RE,
} from './routes-pure.ts'

const VPN_SELECT = {
  id: vpn.id,
  organizationId: vpn.organizationId,
  cidr: vpn.cidr,
  displayName: vpn.name,
  metadata: vpn.metadata,
  options: vpn.options,
  createdAt: vpn.createdAt,
  updatedAt: vpn.updatedAt,
}

const PEER_SELECT = {
  id: peer.id,
  vpnId: peer.vpnId,
  serverId: peer.serverId,
  endpointIpId: peer.endpointIpId,
  tunnelIpId: peer.tunnelIpId,
  role: peer.role,
  publicKey: peer.publicKey,
  listenPort: peer.listenPort,
  endpoint: peer.endpoint,
  metadata: peer.metadata,
  options: peer.options,
  createdAt: peer.createdAt,
  updatedAt: peer.updatedAt,
}

async function assertVpnCidrAvailable(
  c: Context,
  db: Db,
  organizationId: string,
  cidrValue: string,
  excludeVpnId?: string,
): Promise<Response | null> {
  const conditions = [
    eq(vpn.organizationId, organizationId),
    eq(vpn.cidr, cidrValue),
  ]
  if (excludeVpnId) {
    conditions.push(ne(vpn.id, excludeVpnId))
  }
  const [conflict] = await db
    .select({ id: vpn.id })
    .from(vpn)
    .where(and(...conditions))
    .limit(1)
  if (conflict) {
    return c.json({ error: 'vpn_cidr_in_use' }, 409)
  }
  return null
}

/**
 * Reject CIDR changes that would leave existing overlay addresses outside the
 * proposed prefix. Widening and no-op changes are allowed; remapping/shrinking
 * that excludes tunnels must be an explicit reallocation flow (not silent).
 */
async function assertVpnOverlayAddressesFitCidr(
  c: Context,
  db: Db,
  vpnId: string,
  proposedCidr: string,
): Promise<Response | null> {
  const [outside] = await db
    .select({ id: ip.id, address: ip.address })
    .from(ip)
    .where(
      and(
        eq(ip.vpnId, vpnId),
        eq(ip.scope, 'vpn'),
        sql`NOT (${ip.address} <<= ${proposedCidr}::cidr)`,
      ),
    )
    .limit(1)
  if (outside) {
    return c.json({ error: 'vpn_cidr_excludes_addresses' }, 409)
  }
  return null
}

async function resolveVpnCidrPatch(
  c: Context,
  db: Db,
  organizationId: string,
  vpnId: string,
  body: Record<string, unknown>,
): Promise<OptionalStringResult> {
  const cidr = parseOptionalVpnCidrPatch(c, body)
  if (cidr instanceof Response) return cidr
  if (cidr === undefined) return undefined

  const [current] = await db
    .select({ cidr: vpn.cidr })
    .from(vpn)
    .where(eq(vpn.id, vpnId))
    .limit(1)
  // No-op CIDR patches skip uniqueness / containment checks.
  if (current?.cidr === cidr) return cidr

  const conflict = await assertVpnCidrAvailable(
    c,
    db,
    organizationId,
    cidr,
    vpnId,
  )
  if (conflict) return conflict
  const unfit = await assertVpnOverlayAddressesFitCidr(c, db, vpnId, cidr)
  if (unfit) return unfit
  return cidr
}

async function updateVpnRow(
  c: Context,
  db: Db,
  id: string,
  patchFields: VpnPatchFields,
): Promise<Response | null> {
  try {
    await db.update(vpn).set(patchFields).where(eq(vpn.id, id))
    return null
  } catch (err) {
    if (isVpnCidrUniqueViolation(err)) {
      return c.json({ error: 'vpn_cidr_in_use' }, 409)
    }
    throw err
  }
}

async function applyPeerPatchReleasingTunnel(
  db: Db,
  params: {
    peerId: string
    vpnId: string
    previousTunnelIpId: string | null
    patch: PeerPatchFields
  },
): Promise<void> {
  const tunnelReplaced = shouldReleaseTunnelOnPatch(
    params.previousTunnelIpId,
    params.patch.tunnelIpId,
  )

  await db.transaction(async (tx) => {
    await tx.update(peer).set(params.patch).where(eq(peer.id, params.peerId))
    if (tunnelReplaced && params.previousTunnelIpId) {
      await releaseVpnTunnelIpIfOrphaned(tx, {
        vpnId: params.vpnId,
        tunnelIpId: params.previousTunnelIpId,
      })
    }
  })
}

async function validatePeerEndpointIpId(
  c: Context,
  db: Db,
  organizationId: string,
  ipIdRaw: unknown,
): Promise<string | null | undefined | Response> {
  const parsed = parseOptionalScopeUuid(c, ipIdRaw)
  if (parsed instanceof Response) return parsed
  if (parsed === undefined) return undefined
  if (parsed === null) return null
  const ipId = parsed
  const entityOrgId = await resolveEntityOrganizationId(db, 'ip', ipId)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  const [scopedIp] = await db
    .select({ scope: ip.scope })
    .from(ip)
    .where(eq(ip.id, ipId))
    .limit(1)
  if (scopedIp?.scope !== 'public') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return ipId
}

async function validatePeerTunnelIpId(
  c: Context,
  db: Db,
  organizationId: string,
  vpnId: string,
  ipIdRaw: unknown,
  expectedServerId?: string,
): Promise<string | undefined | Response> {
  if (ipIdRaw === undefined) return undefined
  // Clearing a tunnel IP is not supported — omit for auto-allocate on create,
  // or pass a concrete overlay row id on create/patch.
  if (ipIdRaw === null) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const parsed = parseOptionalScopeUuid(c, ipIdRaw)
  if (parsed instanceof Response) return parsed
  if (parsed === null || parsed === undefined) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const ipId = parsed
  const entityOrgId = await resolveEntityOrganizationId(db, 'ip', ipId)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  const [scopedIp] = await db
    .select({
      scope: ip.scope,
      vpnId: ip.vpnId,
      address: ip.address,
      serverId: ip.serverId,
    })
    .from(ip)
    .where(eq(ip.id, ipId))
    .limit(1)
  if (scopedIp?.scope !== 'vpn' || scopedIp.vpnId !== vpnId) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (
    expectedServerId !== undefined &&
    scopedIp.serverId !== null &&
    scopedIp.serverId !== expectedServerId
  ) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const inCidr = await isAddressInVpnCidr(
    db,
    vpnId,
    stripInetPrefixSuffix(scopedIp.address),
  )
  if (!inCidr) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return ipId
}

async function validateOrgServerId(
  c: Context,
  db: Db,
  organizationId: string,
  serverIdRaw: unknown,
): Promise<string | Response> {
  if (typeof serverIdRaw !== 'string' || !UUID_RE.test(serverIdRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const serverOrgId = await resolveEntityOrganizationId(db, 'server', serverIdRaw)
  if (serverOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  return serverIdRaw
}

/**
 * Oldest public IP on the server — used as the WireGuard endpoint when create
 * omits `endpointIpId`.
 */
async function resolveDefaultEndpointIpId(
  db: Db,
  organizationId: string,
  serverId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: ip.id })
    .from(ip)
    .where(
      and(
        eq(ip.organizationId, organizationId),
        eq(ip.serverId, serverId),
        eq(ip.scope, 'public'),
      ),
    )
    .orderBy(asc(ip.createdAt))
    .limit(1)
  return row?.id ?? null
}

async function sealCreatePresharedKey(
  c: Context,
  value: unknown,
): Promise<string | null | Response> {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  if (!dataEncryptionSecrets) {
    return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
  }
  return await encryptSecret(dataEncryptionSecrets, value)
}

type PeerCreateFields = {
  serverId: string
  /** Null until the daemon reports a key after Apply. */
  publicKey: string | null
  endpointIpId: string | null | undefined
  /** Explicit overlay row; omit for auto-allocation. `null` is rejected. */
  tunnelIpId: string | undefined
  /** Explicit overlay address; mutually exclusive with `tunnelIpId`. */
  tunnelAddress: string | undefined
  role: string
  listenPort: number
  endpoint: string | null
  presharedKeySealed: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

type PeerTunnelSelection = {
  /** Explicit overlay row; `undefined` leaves room for auto-allocation. */
  tunnelIpId: string | undefined
  /** Explicit overlay address; mutually exclusive with `tunnelIpId`. */
  tunnelAddress: string | undefined
}

async function parsePeerTunnelSelection(
  c: Context,
  db: Db,
  organizationId: string,
  vpnId: string,
  body: Record<string, unknown>,
  serverId: string,
): Promise<PeerTunnelSelection | Response> {
  const tunnelAddress = parseOptionalTunnelAddress(c, body.tunnelAddress)
  if (tunnelAddress instanceof Response) return tunnelAddress

  const tunnelIpId = await validatePeerTunnelIpId(
    c,
    db,
    organizationId,
    vpnId,
    body.tunnelIpId,
    serverId,
  )
  if (tunnelIpId instanceof Response) return tunnelIpId

  const exclusiveDenied = assertMutuallyExclusiveTunnelSelection(
    c,
    tunnelAddress,
    tunnelIpId,
  )
  if (exclusiveDenied) return exclusiveDenied

  if (tunnelAddress !== undefined) {
    const inCidr = await isAddressInVpnCidr(db, vpnId, tunnelAddress)
    if (!inCidr) {
      return c.json({ error: 'Invalid request' }, 400)
    }
  }

  return { tunnelIpId, tunnelAddress }
}

async function parsePeerCreateFields(
  c: Context,
  db: Db,
  organizationId: string,
  vpnId: string,
  body: Record<string, unknown>,
): Promise<PeerCreateFields | Response> {
  const serverId = await validateOrgServerId(c, db, organizationId, body.serverId)
  if (serverId instanceof Response) return serverId

  const publicKey = parseOptionalPublicKey(c, body.publicKey)
  if (publicKey instanceof Response) return publicKey

  const endpointIpId = await validatePeerEndpointIpId(
    c,
    db,
    organizationId,
    body.endpointIpId,
  )
  if (endpointIpId instanceof Response) return endpointIpId

  const tunnel = await parsePeerTunnelSelection(
    c,
    db,
    organizationId,
    vpnId,
    body,
    serverId,
  )
  if (tunnel instanceof Response) return tunnel

  const role = parsePeerRole(c, body.role, false)
  if (role instanceof Response) return role

  const listenPort = parseCreateOptionalListenPort(c, body.listenPort)
  if (listenPort instanceof Response) return listenPort

  const endpoint = parseCreateOptionalEndpoint(c, body.endpoint)
  if (endpoint instanceof Response) return endpoint

  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult

  const presharedKeySealed = await sealCreatePresharedKey(c, body.presharedKey)
  if (presharedKeySealed instanceof Response) return presharedKeySealed

  const resolvedEndpointIpId = endpointIpId === undefined
    ? await resolveDefaultEndpointIpId(db, organizationId, serverId)
    : endpointIpId

  return {
    serverId,
    publicKey,
    endpointIpId: resolvedEndpointIpId,
    tunnelIpId: tunnel.tunnelIpId,
    tunnelAddress: tunnel.tunnelAddress,
    role: role ?? 'member',
    listenPort,
    endpoint,
    presharedKeySealed,
    metadata: metadataResult,
    options: optionsResult,
  }
}

type TunnelIpResolveResult =
  | { ok: true; tunnelIpId: string }
  | { ok: false; status: 400 | 409; error: string }

async function resolveCreateTunnelIpId(
  tx: Db,
  vpnId: string,
  fields: PeerCreateFields,
): Promise<TunnelIpResolveResult> {
  if (fields.tunnelIpId !== undefined) {
    return { ok: true, tunnelIpId: fields.tunnelIpId }
  }
  if (fields.tunnelAddress !== undefined) {
    try {
      const created = await createVpnTunnelIpAtOnce(tx, {
        vpnId,
        serverId: fields.serverId,
        address: fields.tunnelAddress,
      })
      if ('kind' in created) {
        if (created.kind === 'vpn_address_conflict') {
          return { ok: false, status: 409, error: 'vpn_address_conflict' }
        }
        return { ok: false, status: 400, error: 'Invalid request' }
      }
      return { ok: true, tunnelIpId: created.ipId }
    } catch (err) {
      if (isVpnAddressUniqueViolation(err)) {
        return { ok: false, status: 409, error: 'vpn_address_conflict' }
      }
      throw err
    }
  }

  // Neither tunnelIpId nor tunnelAddress: auto-allocate.
  const allocated = await allocateVpnTunnelIpOnce(tx, {
    vpnId,
    serverId: fields.serverId,
  })
  if ('kind' in allocated) {
    if (allocated.kind === 'vpn_address_pool_exhausted') {
      return { ok: false, status: 409, error: 'vpn_address_pool_exhausted' }
    }
    return { ok: false, status: 400, error: 'Invalid request' }
  }
  return { ok: true, tunnelIpId: allocated.ipId }
}

async function sealPatchPresharedKey(
  c: Context,
  value: unknown,
): Promise<string | null | Response> {
  if (value === null) return null
  if (typeof value === 'string' && value.length > 0) {
    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable — no encryption key configured' }, 503)
    }
    return await encryptSecret(dataEncryptionSecrets, value)
  }
  return c.json({ error: 'Invalid request' }, 400)
}

async function assignPatchServerId(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Promise<Response | null> {
  if (body.serverId === undefined) return null
  const serverId = await validateOrgServerId(c, db, organizationId, body.serverId)
  if (serverId instanceof Response) return serverId
  patch.serverId = serverId
  return null
}

async function assignPatchEndpointIpId(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Promise<Response | null> {
  const endpointIpId = await validatePeerEndpointIpId(
    c,
    db,
    organizationId,
    body.endpointIpId,
  )
  if (endpointIpId instanceof Response) return endpointIpId
  if (endpointIpId !== undefined) patch.endpointIpId = endpointIpId
  return null
}

async function assignPatchTunnelIpId(
  c: Context,
  db: Db,
  organizationId: string,
  vpnId: string,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
  peerServerId: string,
): Promise<Response | null> {
  const expectedServerId = patch.serverId ?? peerServerId
  const tunnelIpId = await validatePeerTunnelIpId(
    c,
    db,
    organizationId,
    vpnId,
    body.tunnelIpId,
    expectedServerId,
  )
  if (tunnelIpId instanceof Response) return tunnelIpId
  if (tunnelIpId !== undefined) patch.tunnelIpId = tunnelIpId
  return null
}

async function assignPatchPresharedKey(
  c: Context,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Promise<Response | null> {
  if (body.presharedKey === undefined) return null
  const sealed = await sealPatchPresharedKey(c, body.presharedKey)
  if (sealed instanceof Response) return sealed
  patch.presharedKey = sealed
  return null
}

async function parsePeerPatchFields(
  c: Context,
  db: Db,
  organizationId: string,
  vpnId: string,
  body: Record<string, unknown>,
  peerServerId: string,
): Promise<PeerPatchFields | Response> {
  const patch: PeerPatchFields = { updatedAt: new Date().toISOString() }

  const serverErr = await assignPatchServerId(c, db, organizationId, body, patch)
  if (serverErr) return serverErr

  const publicKeyErr = assignPatchPublicKey(c, body, patch)
  if (publicKeyErr) return publicKeyErr

  const endpointErr = await assignPatchEndpointIpId(
    c,
    db,
    organizationId,
    body,
    patch,
  )
  if (endpointErr) return endpointErr

  const tunnelErr = await assignPatchTunnelIpId(
    c,
    db,
    organizationId,
    vpnId,
    body,
    patch,
    peerServerId,
  )
  if (tunnelErr) return tunnelErr

  const roleErr = assignPatchRole(c, body, patch)
  if (roleErr) return roleErr

  const listenPortErr = assignPatchListenPort(c, body, patch)
  if (listenPortErr) return listenPortErr

  const endpointHostErr = assignPatchEndpoint(c, body, patch)
  if (endpointHostErr) return endpointHostErr

  const metadataErr = assignPatchJsonbField(c, body, 'metadata', patch)
  if (metadataErr) return metadataErr

  const optionsErr = assignPatchJsonbField(c, body, 'options', patch)
  if (optionsErr) return optionsErr

  const presharedErr = await assignPatchPresharedKey(c, body, patch)
  if (presharedErr) return presharedErr

  return patch
}

type PeerCreateOutcome =
  | { ok: true; id: string }
  | { ok: false; status: 400 | 409; error: string }

async function insertPeerRow(
  db: Db,
  vpnId: string,
  fields: PeerCreateFields,
): Promise<PeerCreateOutcome> {
  return await db.transaction(async (tx): Promise<PeerCreateOutcome> => {
    const tunnel = await resolveCreateTunnelIpId(tx, vpnId, fields)
    if (!tunnel.ok) {
      return { ok: false, status: tunnel.status, error: tunnel.error }
    }

    const [inserted] = await tx
      .insert(peer)
      .values({
        vpnId,
        serverId: fields.serverId,
        role: fields.role,
        listenPort: fields.listenPort,
        ...(fields.publicKey !== null ? { publicKey: fields.publicKey } : {}),
        ...(fields.endpointIpId !== undefined
          ? { endpointIpId: fields.endpointIpId }
          : {}),
        tunnelIpId: tunnel.tunnelIpId,
        ...(fields.endpoint !== null ? { endpoint: fields.endpoint } : {}),
        ...(fields.presharedKeySealed !== null
          ? { presharedKey: fields.presharedKeySealed }
          : {}),
        ...(fields.metadata !== null ? { metadata: fields.metadata } : {}),
        ...(fields.options !== null ? { options: fields.options } : {}),
      })
      .returning({ id: peer.id })
    return { ok: true, id: inserted.id }
  })
}

/**
 * Second (and final) attempt after an auto-allocated overlay address lost a
 * race; a repeated address collision means the pool is effectively exhausted.
 */
async function retryPeerInsertAfterAddressRace(
  db: Db,
  vpnId: string,
  fields: PeerCreateFields,
): Promise<PeerCreateOutcome> {
  try {
    return await insertPeerRow(db, vpnId, fields)
  } catch (retryErr) {
    const conflict = peerUniqueConflictError(retryErr)
    if (conflict) return { ok: false, status: 409, error: conflict }
    if (isVpnAddressUniqueViolation(retryErr)) {
      return { ok: false, status: 409, error: 'vpn_address_pool_exhausted' }
    }
    throw retryErr
  }
}

async function createPeer(
  db: Db,
  vpnId: string,
  fields: PeerCreateFields,
): Promise<PeerCreateOutcome> {
  const autoAllocate = isAutoAllocateTunnel(fields.tunnelIpId, fields.tunnelAddress)

  try {
    return await insertPeerRow(db, vpnId, fields)
  } catch (err) {
    const conflict = peerUniqueConflictError(err)
    if (conflict) return { ok: false, status: 409, error: conflict }
    if (!isVpnAddressUniqueViolation(err)) throw err
    if (autoAllocate) {
      return await retryPeerInsertAfterAddressRace(db, vpnId, fields)
    }
    const explicitConflict = mapExplicitTunnelAddressConflict(
      fields.tunnelAddress !== undefined,
    )
    if (explicitConflict) {
      return { ok: false, status: explicitConflict.status, error: explicitConflict.error }
    }
    throw err
  }
}

export function registerVpnRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for vpn routes')
  }
  const secrets = opts.secrets

  router.use('/vpns', createSessionMiddleware(secrets))
  router.use('/vpns/:id', createSessionMiddleware(secrets))
  router.use('/vpns/:id/peers', createSessionMiddleware(secrets))
  router.use('/vpns/:id/peers/:peerId', createSessionMiddleware(secrets))
  router.use('/vpns/:id/apply', createSessionMiddleware(secrets))

  router.get('/vpns', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const manageDenied = await assertCanManageOr403(c, 'organization', organizationId)
    if (manageDenied) return manageDenied

    const visibleIds = await listVisible(db, {
      kind: 'vpn',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ vpns: [] })
    }

    const rows = await db
      .select(VPN_SELECT)
      .from(vpn)
      .where(and(inArray(vpn.id, visibleIds), eq(vpn.organizationId, organizationId)))
      .orderBy(vpn.createdAt)

    return c.json({ vpns: rows })
  })

  router.get('/vpns/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'vpn', id)
    if (denied) return denied

    const [row] = await db
      .select(VPN_SELECT)
      .from(vpn)
      .where(eq(vpn.id, id))
      .limit(1)

    if (!row) return c.json({ error: 'Not found' }, 404)

    return c.json({ vpn: row })
  })

  router.post('/vpns', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const denied = await assertCanCreateOr403(c, 'organization', organizationId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let displayName: string | null
    try {
      displayName = parseDisplayName(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult
    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult

    const cidr = parseRequiredVpnCidr(c, body)
    if (cidr instanceof Response) return cidr

    const conflict = await assertVpnCidrAvailable(c, db, organizationId, cidr)
    if (conflict) return conflict

    let id: string | undefined
    try {
      id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(vpn)
          .values({
            organizationId,
            cidr,
            name: displayName,
            ...(metadataResult !== null ? { metadata: metadataResult } : {}),
            ...(optionsResult !== null ? { options: optionsResult } : {}),
          })
          .returning({ id: vpn.id })

        return inserted?.id
      })
    } catch (err) {
      if (isVpnCidrUniqueViolation(err)) {
        return c.json({ error: 'vpn_cidr_in_use' }, 409)
      }
      throw err
    }

    if (!id) {
      return c.json({ error: 'Failed to create VPN' }, 500)
    }

    return c.json({
      ok: true as const,
      id,
    })
  })

  router.patch('/vpns/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'vpn', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let patchFields: VpnPatchFields
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const jsonbErr = applyVpnJsonbPatchFields(c, body, patchFields)
    if (jsonbErr) return jsonbErr

    const cidr = await resolveVpnCidrPatch(c, db, organizationId, id, body)
    if (cidr instanceof Response) return cidr
    if (cidr !== undefined) patchFields.cidr = cidr

    const updateErr = await updateVpnRow(c, db, id, patchFields)
    if (updateErr) return updateErr

    return c.json({ ok: true as const })
  })

  router.delete('/vpns/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const id = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', id)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'vpn', id)
    if (denied) return denied

    await db.delete(vpn).where(eq(vpn.id, id))

    return c.json({ ok: true as const })
  })

  router.get('/vpns/:id/peers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const vpnId = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', vpnId)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'vpn', vpnId)
    if (denied) return denied

    const rows = await db
      .select(PEER_SELECT)
      .from(peer)
      .where(eq(peer.vpnId, vpnId))
      .orderBy(peer.createdAt)

    return c.json({ peers: rows })
  })

  router.post('/vpns/:id/peers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const vpnId = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', vpnId)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'vpn', vpnId)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const fields = await parsePeerCreateFields(c, db, organizationId, vpnId, body)
    if (fields instanceof Response) return fields

    const outcome = await createPeer(db, vpnId, fields)
    if (!outcome.ok) {
      return c.json({ error: outcome.error }, outcome.status)
    }

    return c.json({ ok: true as const, id: outcome.id })
  })

  router.patch('/vpns/:id/peers/:peerId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const vpnId = c.req.param('id')
    const peerId = c.req.param('peerId')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', vpnId)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'vpn', vpnId)
    if (denied) return denied

    const [existingPeer] = await db
      .select({
        id: peer.id,
        tunnelIpId: peer.tunnelIpId,
        serverId: peer.serverId,
      })
      .from(peer)
      .where(and(eq(peer.id, peerId), eq(peer.vpnId, vpnId)))
      .limit(1)
    if (!existingPeer) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patch = await parsePeerPatchFields(
      c,
      db,
      organizationId,
      vpnId,
      body,
      existingPeer.serverId,
    )
    if (patch instanceof Response) return patch

    try {
      await applyPeerPatchReleasingTunnel(db, {
        peerId,
        vpnId,
        previousTunnelIpId: existingPeer.tunnelIpId,
        patch,
      })
    } catch (err) {
      const conflict = peerUniqueConflictResponse(c, err)
      if (conflict) return conflict
      throw err
    }

    return c.json({ ok: true as const })
  })

  router.delete('/vpns/:id/peers/:peerId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const vpnId = c.req.param('id')
    const peerId = c.req.param('peerId')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', vpnId)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'vpn', vpnId)
    if (denied) return denied

    const [existingPeer] = await db
      .select({ id: peer.id, tunnelIpId: peer.tunnelIpId })
      .from(peer)
      .where(and(eq(peer.id, peerId), eq(peer.vpnId, vpnId)))
      .limit(1)
    if (!existingPeer) return c.json({ error: 'Not found' }, 404)

    await db.transaction(async (tx) => {
      await tx.delete(peer).where(eq(peer.id, peerId))
      if (existingPeer.tunnelIpId) {
        await releaseVpnTunnelIpIfOrphaned(tx, {
          vpnId,
          tunnelIpId: existingPeer.tunnelIpId,
        })
      }
    })

    return c.json({ ok: true as const })
  })

  router.post('/vpns/:id/apply', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const vpnId = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'vpn', vpnId)
    if (entityOrgId !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'organization:manage', 'vpn', vpnId)
    if (denied) return denied

    const secretsConfig = c.get('secretsConfig')
    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    const resealDeps: VpnApplyResealDeps | undefined =
      secretsConfig && dataEncryptionSecrets
        ? { secretsConfig, dataEncryptionSecrets }
        : undefined

    const prepared = await prepareVpnApplyPayloads(db, vpnId, resealDeps)
    if ('kind' in prepared) {
      const err = prepared as VpnApplyPrepareError
      return c.json({ error: err.kind }, 422)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const results = await enqueuePreparedVpnApply({
      db,
      commandQueue,
      actorType: 'user',
      actorId: session.userId,
      prepared,
    })

    return c.json({
      ok: true as const,
      vpnId,
      interfaceName: prepared.interfaceName,
      results,
    })
  })
}
