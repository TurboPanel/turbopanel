import { and, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403, listVisible } from '../authz/index.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import { createCommandRecord } from '../../lib/db/command-records.ts'
import { ip, network, peer, vpn } from '../../lib/db/schema.ts'
import { isValidWireguardPublicKey } from '../../lib/commands/wireguard.ts'
import { isValidIpAddress, isValidCidr } from '../../lib/ip-address.ts'
import {
  assertDispatchInfrastructure,
  enqueueCommandOrCompensate,
} from '../servers/command-dispatch.ts'
import {
  prepareVpnApplyPayloads,
  type VpnApplyPrepareError,
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VPN_SELECT = {
  id: vpn.id,
  organizationId: vpn.organizationId,
  networkId: vpn.networkId,
  displayName: vpn.displayName,
  metadata: vpn.metadata,
  options: vpn.options,
  createdAt: vpn.createdAt,
  updatedAt: vpn.updatedAt,
}

const PEER_SELECT = {
  id: peer.id,
  vpnId: peer.vpnId,
  serverId: peer.serverId,
  ipId: peer.ipId,
  publicKey: peer.publicKey,
  tunnelAddress: peer.tunnelAddress,
  listenPort: peer.listenPort,
  endpoint: peer.endpoint,
  metadata: peer.metadata,
  options: peer.options,
  createdAt: peer.createdAt,
  updatedAt: peer.updatedAt,
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

function isPeerUniqueViolation(err: unknown): 'server' | 'public_key' | null {
  if (!isPostgresUniqueViolation(err)) return null
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('peer_vpn_server_unique')) return 'server'
  if (message.includes('peer_vpn_public_key_unique')) return 'public_key'
  return null
}

async function validateOptionalNetworkId(
  c: Context,
  db: Db,
  organizationId: string,
  networkIdRaw: unknown,
): Promise<string | null | undefined | Response> {
  if (networkIdRaw === undefined) return undefined
  if (networkIdRaw === null) return null
  if (typeof networkIdRaw !== 'string' || !UUID_RE.test(networkIdRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const entityOrgId = await resolveEntityOrganizationId(db, 'network', networkIdRaw)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  const [netRow] = await db
    .select({ kind: network.kind })
    .from(network)
    .where(eq(network.id, networkIdRaw))
    .limit(1)
  if (netRow && netRow.kind !== 'vpn') {
    return c.json({ error: 'network_kind_mismatch' }, 400)
  }
  return networkIdRaw
}

function parseOptionalMeshCidr(
  c: Context,
  body: Record<string, unknown>,
): string | undefined | Response {
  if (body.meshCidr === undefined) return undefined
  if (typeof body.meshCidr !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const trimmed = body.meshCidr.trim()
  if (trimmed.length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (!isValidCidr(trimmed)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return trimmed
}

function vpnNetworkDisplayName(vpnDisplayName: string | null, meshCidr: string): string {
  const base = vpnDisplayName?.trim()
  if (base && base.length > 0) {
    const suffix = ' mesh'
    const maxBase = 255 - suffix.length
    return `${base.slice(0, maxBase)}${suffix}`
  }
  const prefix = 'VPN '
  const maxCidr = 255 - prefix.length
  return `${prefix}${meshCidr.slice(0, maxCidr)}`
}

async function validatePeerIpId(
  c: Context,
  db: Db,
  organizationId: string,
  ipIdRaw: unknown,
): Promise<string | null | undefined | Response> {
  if (ipIdRaw === undefined) return undefined
  if (ipIdRaw === null) return null
  if (typeof ipIdRaw !== 'string' || !UUID_RE.test(ipIdRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const entityOrgId = await resolveEntityOrganizationId(db, 'ip', ipIdRaw)
  if (entityOrgId !== organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }
  const [scopedIp] = await db
    .select({ scope: ip.scope })
    .from(ip)
    .where(eq(ip.id, ipIdRaw))
    .limit(1)
  if (scopedIp?.scope !== 'public') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return ipIdRaw
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

type NullableStringOrResponse = string | null | Response
type NullableNumberOrResponse = number | null | Response

function parseRequiredPublicKey(
  c: Context,
  publicKeyRaw: unknown,
): string | Response {
  if (typeof publicKeyRaw !== 'string' || publicKeyRaw.trim().length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const publicKey = publicKeyRaw.trim()
  if (!isValidWireguardPublicKey(publicKey)) {
    return c.json({ error: 'Invalid WireGuard public key' }, 400)
  }
  return publicKey
}

function parseCreateOptionalTunnelAddress(
  c: Context,
  value: unknown,
): NullableStringOrResponse {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !isValidIpAddress(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value.trim()
}

function parseCreateOptionalListenPort(
  c: Context,
  value: unknown,
): NullableNumberOrResponse {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

function parseCreateOptionalEndpoint(
  c: Context,
  value: unknown,
): NullableStringOrResponse {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value.trim().length > 0 ? value.trim() : null
}

async function sealCreatePresharedKey(
  c: Context,
  value: unknown,
): Promise<NullableStringOrResponse> {
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
  publicKey: string
  ipId: string | null | undefined
  tunnelAddress: string | null
  listenPort: number | null
  endpoint: string | null
  presharedKeySealed: string | null
  metadata: Record<string, unknown> | null
  options: Record<string, unknown> | null
}

async function parsePeerCreateFields(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
): Promise<PeerCreateFields | Response> {
  const serverId = await validateOrgServerId(c, db, organizationId, body.serverId)
  if (serverId instanceof Response) return serverId

  const publicKey = parseRequiredPublicKey(c, body.publicKey)
  if (publicKey instanceof Response) return publicKey

  const ipId = await validatePeerIpId(c, db, organizationId, body.ipId)
  if (ipId instanceof Response) return ipId

  const tunnelAddress = parseCreateOptionalTunnelAddress(c, body.tunnelAddress)
  if (tunnelAddress instanceof Response) return tunnelAddress

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

  return {
    serverId,
    publicKey,
    ipId,
    tunnelAddress,
    listenPort,
    endpoint,
    presharedKeySealed,
    metadata: metadataResult,
    options: optionsResult,
  }
}

type PeerPatchFields = {
  serverId?: string
  ipId?: string | null
  publicKey?: string
  tunnelAddress?: string | null
  listenPort?: number | null
  endpoint?: string | null
  presharedKey?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

function parsePatchTunnelAddress(
  c: Context,
  value: unknown,
): NullableStringOrResponse {
  if (value === null) return null
  if (typeof value === 'string' && isValidIpAddress(value)) {
    return value.trim()
  }
  return c.json({ error: 'Invalid request' }, 400)
}

function parsePatchListenPort(
  c: Context,
  value: unknown,
): NullableNumberOrResponse {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  return c.json({ error: 'Invalid request' }, 400)
}

function parsePatchEndpoint(
  c: Context,
  value: unknown,
): NullableStringOrResponse {
  if (value === null) return null
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : null
  }
  return c.json({ error: 'Invalid request' }, 400)
}

async function sealPatchPresharedKey(
  c: Context,
  value: unknown,
): Promise<NullableStringOrResponse> {
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

function assignPatchPublicKey(
  c: Context,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Response | null {
  if (body.publicKey === undefined) return null
  const publicKey = parseRequiredPublicKey(c, body.publicKey)
  if (publicKey instanceof Response) return publicKey
  patch.publicKey = publicKey
  return null
}

async function assignPatchIpId(
  c: Context,
  db: Db,
  organizationId: string,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Promise<Response | null> {
  const ipId = await validatePeerIpId(c, db, organizationId, body.ipId)
  if (ipId instanceof Response) return ipId
  if (ipId !== undefined) patch.ipId = ipId
  return null
}

function assignPatchTunnelAddress(
  c: Context,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Response | null {
  if (body.tunnelAddress === undefined) return null
  const tunnelAddress = parsePatchTunnelAddress(c, body.tunnelAddress)
  if (tunnelAddress instanceof Response) return tunnelAddress
  patch.tunnelAddress = tunnelAddress
  return null
}

function assignPatchListenPort(
  c: Context,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Response | null {
  if (body.listenPort === undefined) return null
  const listenPort = parsePatchListenPort(c, body.listenPort)
  if (listenPort instanceof Response) return listenPort
  patch.listenPort = listenPort
  return null
}

function assignPatchEndpoint(
  c: Context,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Response | null {
  if (body.endpoint === undefined) return null
  const endpoint = parsePatchEndpoint(c, body.endpoint)
  if (endpoint instanceof Response) return endpoint
  patch.endpoint = endpoint
  return null
}

function assignPatchJsonbField(
  c: Context,
  body: Record<string, unknown>,
  field: 'metadata' | 'options',
  patch: PeerPatchFields,
): Response | null {
  const parsed = parseJsonbObject(c, body, field)
  if (parsed instanceof Response) return parsed
  if (parsed !== null) patch[field] = parsed
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
  body: Record<string, unknown>,
): Promise<PeerPatchFields | Response> {
  const patch: PeerPatchFields = { updatedAt: new Date().toISOString() }

  const serverErr = await assignPatchServerId(c, db, organizationId, body, patch)
  if (serverErr) return serverErr

  const publicKeyErr = assignPatchPublicKey(c, body, patch)
  if (publicKeyErr) return publicKeyErr

  const ipErr = await assignPatchIpId(c, db, organizationId, body, patch)
  if (ipErr) return ipErr

  const tunnelErr = assignPatchTunnelAddress(c, body, patch)
  if (tunnelErr) return tunnelErr

  const listenPortErr = assignPatchListenPort(c, body, patch)
  if (listenPortErr) return listenPortErr

  const endpointErr = assignPatchEndpoint(c, body, patch)
  if (endpointErr) return endpointErr

  const metadataErr = assignPatchJsonbField(c, body, 'metadata', patch)
  if (metadataErr) return metadataErr

  const optionsErr = assignPatchJsonbField(c, body, 'options', patch)
  if (optionsErr) return optionsErr

  const presharedErr = await assignPatchPresharedKey(c, body, patch)
  if (presharedErr) return presharedErr

  return patch
}

function peerUniqueConflictResponse(c: Context, err: unknown): Response | null {
  const kind = isPeerUniqueViolation(err)
  if (kind === 'server') {
    return c.json({ error: 'peer_server_conflict' }, 409)
  }
  if (kind === 'public_key') {
    return c.json({ error: 'peer_public_key_conflict' }, 409)
  }
  return null
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

    const networkId = await validateOptionalNetworkId(c, db, organizationId, body.networkId)
    if (networkId instanceof Response) return networkId

    const meshCidr = parseOptionalMeshCidr(c, body)
    if (meshCidr instanceof Response) return meshCidr
    if (networkId && meshCidr !== undefined) {
      return c.json({ error: 'vpn_network_input_conflict' }, 400)
    }

    const result = await db.transaction(async (tx) => {
      let resolvedNetworkId = networkId ?? null
      if (!resolvedNetworkId && meshCidr !== undefined) {
        const [netRow] = await tx
          .insert(network)
          .values({
            organizationId,
            kind: 'vpn',
            cidr: meshCidr,
            displayName: vpnNetworkDisplayName(displayName, meshCidr),
          })
          .returning({ id: network.id })
        resolvedNetworkId = netRow?.id ?? null
      }

      const [inserted] = await tx
        .insert(vpn)
        .values({
          organizationId,
          displayName,
          ...(resolvedNetworkId ? { networkId: resolvedNetworkId } : {}),
          ...(metadataResult !== null ? { metadata: metadataResult } : {}),
          ...(optionsResult !== null ? { options: optionsResult } : {}),
        })
        .returning({ id: vpn.id, networkId: vpn.networkId })

      return inserted
    })

    if (!result?.id) {
      return c.json({ error: 'Failed to create VPN' }, 500)
    }

    return c.json({
      ok: true as const,
      id: result.id,
      ...(result.networkId ? { networkId: result.networkId } : {}),
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

    let patchFields: {
      displayName?: string | null
      metadata?: Record<string, unknown> | null
      options?: Record<string, unknown> | null
      networkId?: string | null
      updatedAt: string
    }
    try {
      patchFields = buildPatchUpdateFields(body)
    } catch {
      return c.json({ error: 'Invalid request' }, 400)
    }

    const metadataResult = parseJsonbObject(c, body, 'metadata')
    if (metadataResult instanceof Response) return metadataResult
    if (metadataResult !== null) patchFields.metadata = metadataResult

    const optionsResult = parseJsonbObject(c, body, 'options')
    if (optionsResult instanceof Response) return optionsResult
    if (optionsResult !== null) patchFields.options = optionsResult

    const networkId = await validateOptionalNetworkId(c, db, organizationId, body.networkId)
    if (networkId instanceof Response) return networkId
    if (networkId !== undefined) patchFields.networkId = networkId

    await db.update(vpn).set(patchFields).where(eq(vpn.id, id))

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

    const fields = await parsePeerCreateFields(c, db, organizationId, body)
    if (fields instanceof Response) return fields

    try {
      const id = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(peer)
          .values({
            vpnId,
            serverId: fields.serverId,
            publicKey: fields.publicKey,
            ...(fields.ipId !== undefined ? { ipId: fields.ipId } : {}),
            ...(fields.tunnelAddress !== null ? { tunnelAddress: fields.tunnelAddress } : {}),
            ...(fields.listenPort !== null ? { listenPort: fields.listenPort } : {}),
            ...(fields.endpoint !== null ? { endpoint: fields.endpoint } : {}),
            ...(fields.presharedKeySealed !== null
              ? { presharedKey: fields.presharedKeySealed }
              : {}),
            ...(fields.metadata !== null ? { metadata: fields.metadata } : {}),
            ...(fields.options !== null ? { options: fields.options } : {}),
          })
          .returning({ id: peer.id })
        return inserted.id
      })
      return c.json({ ok: true as const, id })
    } catch (err) {
      const conflict = peerUniqueConflictResponse(c, err)
      if (conflict) return conflict
      throw err
    }
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
      .select({ id: peer.id })
      .from(peer)
      .where(and(eq(peer.id, peerId), eq(peer.vpnId, vpnId)))
      .limit(1)
    if (!existingPeer) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const patch = await parsePeerPatchFields(c, db, organizationId, body)
    if (patch instanceof Response) return patch

    try {
      await db.update(peer).set(patch).where(eq(peer.id, peerId))
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
      .select({ id: peer.id })
      .from(peer)
      .where(and(eq(peer.id, peerId), eq(peer.vpnId, vpnId)))
      .limit(1)
    if (!existingPeer) return c.json({ error: 'Not found' }, 404)

    await db.delete(peer).where(eq(peer.id, peerId))

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

    const prepared = await prepareVpnApplyPayloads(c, db, vpnId)
    if ('kind' in prepared) {
      const err = prepared as VpnApplyPrepareError
      return c.json({ error: err.kind }, 422)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    const results = await Promise.all(
      prepared.payloads.map(async ({ serverId: targetServerId, payload }) => {
        const peerId = payload.peerId

        try {
          const record = await createCommandRecord(db, {
            serverId: targetServerId,
            actorType: 'user',
            actorId: session.userId,
            type: 'server.wireguard.apply',
            payload,
            expiresAt,
          })

          const envelope: CommandEnvelope = {
            commandId: record.id,
            serverId: targetServerId,
            type: 'server.wireguard.apply',
            attempt: 1,
            queuedAt: record.queuedAt ?? record.createdAt,
          }

          const enqueueError = await enqueueCommandOrCompensate(
            db,
            commandQueue,
            record,
            envelope,
            c,
          )
          if (enqueueError) {
            return {
              peerId,
              serverId: targetServerId,
              status: 'failed' as const,
              error: 'Command queue unavailable',
            }
          }

          return {
            peerId,
            serverId: targetServerId,
            commandId: record.id,
            status: 'queued' as const,
          }
        } catch {
          return {
            peerId,
            serverId: targetServerId,
            status: 'failed' as const,
            error: 'enqueue_failed',
          }
        }
      }),
    )

    return c.json({
      ok: true as const,
      vpnId,
      interfaceName: prepared.interfaceName,
      results,
    })
  })
}
