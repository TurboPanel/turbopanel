import type { Context } from 'hono'
import {
  isValidWireguardPublicKey,
  WIREGUARD_DEFAULT_LISTEN_PORT,
} from '../../lib/commands/wireguard.ts'
import { isValidCidr, isValidIpAddress, stripInetPrefixSuffix } from '../../lib/ip-address.ts'
import { parseJsonbObject } from '../shared.ts'

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const PEER_ROLES = new Set(['gateway', 'member'])

/** Optional string field: value present, omitted (`undefined`), or HTTP error response. */
export type OptionalStringResult = string | undefined | Response

/** Nullable string field: value, explicit null, or HTTP error response. */
export type NullableStringResult = string | null | Response

export type OptionalUuidParse =
  | { ok: true; value: string | null | undefined }
  | { ok: false }

export function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

/** True when the unique violation is on `vpn(organization_id, cidr)`. */
export function isVpnCidrUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_vpn_organization_id_cidr')
}

export function isPeerUniqueViolation(
  err: unknown,
): 'server' | 'public_key' | 'tunnel_ip' | null {
  if (!isPostgresUniqueViolation(err)) return null
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('peer_vpn_server_unique')) return 'server'
  if (message.includes('peer_vpn_public_key_unique')) return 'public_key'
  if (message.includes('uniq_peer_vpn_tunnel_ip')) return 'tunnel_ip'
  return null
}

export function peerUniqueConflictError(err: unknown): string | null {
  const kind = isPeerUniqueViolation(err)
  if (kind === 'server') return 'peer_server_conflict'
  if (kind === 'public_key') return 'peer_public_key_conflict'
  if (kind === 'tunnel_ip') return 'peer_tunnel_ip_conflict'
  return null
}

export function peerUniqueConflictResponse(c: Context, err: unknown): Response | null {
  const error = peerUniqueConflictError(err)
  if (!error) return null
  return c.json({ error }, 409)
}

export function parseRequiredVpnCidr(
  c: Context,
  body: Record<string, unknown>,
): string | Response {
  if (typeof body.cidr !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const trimmed = body.cidr.trim()
  if (trimmed.length === 0 || !isValidCidr(trimmed)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return trimmed
}

export function parseOptionalVpnCidrPatch(
  c: Context,
  body: Record<string, unknown>,
): OptionalStringResult {
  if (body.cidr === undefined) return undefined
  if (typeof body.cidr !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const trimmed = body.cidr.trim()
  if (trimmed.length === 0 || !isValidCidr(trimmed)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return trimmed
}

export type VpnPatchFields = {
  displayName?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  cidr?: string
  updatedAt: string
}

/** Parses `metadata`/`options` from a PATCH body directly onto `patchFields`. */
export function applyVpnJsonbPatchFields(
  c: Context,
  body: Record<string, unknown>,
  patchFields: VpnPatchFields,
): Response | null {
  const metadataResult = parseJsonbObject(c, body, 'metadata')
  if (metadataResult instanceof Response) return metadataResult
  if (metadataResult !== null) patchFields.metadata = metadataResult

  const optionsResult = parseJsonbObject(c, body, 'options')
  if (optionsResult instanceof Response) return optionsResult
  if (optionsResult !== null) patchFields.options = optionsResult

  return null
}

export function parseOptionalTunnelAddress(
  c: Context,
  value: unknown,
): OptionalStringResult {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const trimmed = stripInetPrefixSuffix(value.trim())
  if (trimmed.length === 0 || !isValidIpAddress(trimmed)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return trimmed
}

export function parsePeerRole(
  c: Context,
  value: unknown,
  required: boolean,
): OptionalStringResult {
  if (value === undefined) {
    return required ? c.json({ error: 'Invalid request' }, 400) : undefined
  }
  if (typeof value !== 'string' || !PEER_ROLES.has(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function parseOptionalPublicKey(
  c: Context,
  publicKeyRaw: unknown,
): NullableStringResult {
  if (publicKeyRaw === undefined || publicKeyRaw === null) return null
  if (typeof publicKeyRaw !== 'string' || publicKeyRaw.trim().length === 0) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const publicKey = publicKeyRaw.trim()
  if (!isValidWireguardPublicKey(publicKey)) {
    return c.json({ error: 'Invalid WireGuard public key' }, 400)
  }
  return publicKey
}

export function parseRequiredPublicKey(
  c: Context,
  publicKeyRaw: unknown,
): string | Response {
  const publicKey = parseOptionalPublicKey(c, publicKeyRaw)
  if (publicKey instanceof Response) return publicKey
  if (publicKey === null) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return publicKey
}

export function parseCreateOptionalListenPort(
  c: Context,
  value: unknown,
): number | Response {
  if (value === undefined || value === null) {
    return WIREGUARD_DEFAULT_LISTEN_PORT
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  if (value < 1 || value > 65_535) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value
}

export function parseCreateOptionalEndpoint(
  c: Context,
  value: unknown,
): NullableStringResult {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return value.trim().length > 0 ? value.trim() : null
}

export function parsePatchListenPort(
  c: Context,
  value: unknown,
): number | null | Response {
  if (value === null) return null
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  return c.json({ error: 'Invalid request' }, 400)
}

export function parsePatchEndpoint(
  c: Context,
  value: unknown,
): NullableStringResult {
  if (value === null) return null
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : null
  }
  return c.json({ error: 'Invalid request' }, 400)
}

/** Reject supplying both explicit overlay row id and overlay address. */
export function assertMutuallyExclusiveTunnelSelection(
  c: Context,
  tunnelAddress: string | undefined,
  tunnelIpId: string | undefined,
): Response | null {
  if (tunnelAddress !== undefined && tunnelIpId !== undefined) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return null
}

export function isAutoAllocateTunnel(
  tunnelIpId: string | undefined,
  tunnelAddress: string | undefined,
): boolean {
  return tunnelIpId === undefined && tunnelAddress === undefined
}

export function shouldReleaseTunnelOnPatch(
  previousTunnelIpId: string | null,
  nextTunnelIpId: string | undefined,
): boolean {
  return nextTunnelIpId !== undefined &&
    previousTunnelIpId !== null &&
    previousTunnelIpId !== nextTunnelIpId
}

export type PeerPatchFields = {
  serverId?: string
  endpointIpId?: string | null
  /** Replacement overlay row; `null` is rejected (cannot clear). */
  tunnelIpId?: string
  role?: string
  publicKey?: string
  listenPort?: number | null
  endpoint?: string | null
  presharedKey?: string | null
  metadata?: Record<string, unknown> | null
  options?: Record<string, unknown> | null
  updatedAt: string
}

export function assignPatchPublicKey(
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

export function assignPatchRole(
  c: Context,
  body: Record<string, unknown>,
  patch: PeerPatchFields,
): Response | null {
  if (body.role === undefined) return null
  const role = parsePeerRole(c, body.role, true)
  if (role instanceof Response) return role
  if (role !== undefined) patch.role = role
  return null
}

export function assignPatchListenPort(
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

export function assignPatchEndpoint(
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

export function assignPatchJsonbField(
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

export function parseOptionalUuid(value: unknown): OptionalUuidParse {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    return { ok: false }
  }
  return { ok: true, value }
}

export function parseOptionalScopeUuid(
  c: Context,
  value: unknown,
): NullableStringResult | undefined {
  const parsed = parseOptionalUuid(value)
  if (!parsed.ok) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  return parsed.value
}

export type CreatePeerAddressErrorOutcome =
  | { ok: false; status: 409; error: 'vpn_address_conflict' | 'vpn_address_pool_exhausted' }
  | null

/**
 * Maps a unique-violation on peer insert when the caller supplied an explicit
 * tunnel address (not auto-allocate).
 */
export function mapExplicitTunnelAddressConflict(
  hasTunnelAddress: boolean,
): CreatePeerAddressErrorOutcome {
  if (hasTunnelAddress) {
    return { ok: false, status: 409, error: 'vpn_address_conflict' }
  }
  return null
}
