import type { Db } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  fabricEnqueueTypedError,
  type FabricEnqueueResult,
  type reconcileFabricMembership,
} from '../../lib/fabric/enqueue.ts'
import {
  type EndpointAddressCaches,
  FabricAllocationError,
  type FabricRecord,
  type FabricSegmentMaterial,
  type RelayRecord,
  type RelayRole,
  resolveRelayEndpointAddress,
} from '../../lib/db/fabric-records.ts'
import { parseFabricOptions } from '../../lib/fabric/cidr.ts'
import { isValidCidr, isValidIpAddress } from '../../lib/ip-address.ts'
import { isValidWireguardPublicKey } from '../../lib/fabric/wg.ts'
import type { GatewayRelayReadyError } from '../../lib/net/datacenter-networks.ts'

export type FabricMembershipSecrets = Pick<
  Parameters<typeof reconcileFabricMembership>[0],
  'secretsConfig' | 'dataEncryptionSecrets'
>

export type RelayPatchReconcileFn = typeof reconcileFabricMembership

export type { RelayMetadata } from '../../lib/db/fabric-records.ts'

const ADVERTISED_CIDRS_MAX = 32

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseFabricPutBody(
  body: unknown,
): { ok: true; enabled: boolean } | { ok: false; error: string } {
  if (!isPlainObject(body) || typeof body.enabled !== 'boolean') {
    return { ok: false, error: 'Invalid request' }
  }
  return { ok: true, enabled: body.enabled }
}

export type RelayPatchBody = {
  role?: RelayRole
  advertisedCidrs?: string[]
  keepalive?: number | null
  endpointAddress?: string | null
  presharedKey?: string | null
}

function parseRelayRoleField(value: unknown): FieldResult<RelayRole> {
  if (value !== 'gateway' && value !== 'member') {
    return { ok: false, error: 'Invalid role' }
  }
  return { ok: true, value }
}

function parseAdvertisedCidrsField(value: unknown): FieldResult<string[]> {
  if (!Array.isArray(value) || value.length > ADVERTISED_CIDRS_MAX) {
    return { ok: false, error: 'Invalid advertisedCidrs' }
  }
  const cidrs: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isValidCidr(entry)) {
      return { ok: false, error: 'Invalid advertisedCidrs' }
    }
    cidrs.push(entry.trim())
  }
  return { ok: true, value: cidrs }
}

function parseKeepaliveField(value: unknown): FieldResult<number | null> {
  if (value === null) return { ok: true, value: null }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    return { ok: false, error: 'Invalid keepalive' }
  }
  return { ok: true, value }
}

function parseEndpointAddressField(value: unknown): FieldResult<string | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isValidIpAddress(value)) {
    return { ok: false, error: 'Invalid endpointAddress' }
  }
  return { ok: true, value }
}

function parsePresharedKeyField(value: unknown): FieldResult<string | null> {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isValidWireguardPublicKey(value)) {
    return { ok: false, error: 'Invalid presharedKey' }
  }
  return { ok: true, value }
}

function applyOptionalPatchField<K extends keyof RelayPatchBody>(
  patch: RelayPatchBody,
  key: K,
  raw: unknown,
  parse: (value: unknown) => FieldResult<Exclude<RelayPatchBody[K], undefined>>,
): { ok: true } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true }
  const parsed = parse(raw)
  if (!parsed.ok) return parsed
  patch[key] = parsed.value
  return { ok: true }
}

export function parseRelayPatchBody(
  body: unknown,
): { ok: true; patch: RelayPatchBody } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: 'Invalid request' }

  const patch: RelayPatchBody = {}
  const role = applyOptionalPatchField(
    patch,
    'role',
    body.role,
    parseRelayRoleField,
  )
  if (!role.ok) return role
  const cidrs = applyOptionalPatchField(
    patch,
    'advertisedCidrs',
    body.advertisedCidrs,
    parseAdvertisedCidrsField,
  )
  if (!cidrs.ok) return cidrs
  const keepalive = applyOptionalPatchField(
    patch,
    'keepalive',
    body.keepalive,
    parseKeepaliveField,
  )
  if (!keepalive.ok) return keepalive
  const endpoint = applyOptionalPatchField(
    patch,
    'endpointAddress',
    body.endpointAddress,
    parseEndpointAddressField,
  )
  if (!endpoint.ok) return endpoint
  const psk = applyOptionalPatchField(
    patch,
    'presharedKey',
    body.presharedKey,
    parsePresharedKeyField,
  )
  if (!psk.ok) return psk

  if (patch.role === 'member') {
    patch.advertisedCidrs = []
  }

  return { ok: true, patch }
}

export type RelayPatchUpdateFields = {
  role?: RelayRole
  advertisedCidrs?: string[]
  keepalive?: number | null
  endpointAddress?: string | null
  presharedKey?: string | null
}

export function relayPatchUpdateFields(
  patch: RelayPatchBody,
  sealedPresharedKey: string | null | undefined,
): RelayPatchUpdateFields {
  const fields: RelayPatchUpdateFields = {}
  if (patch.role) fields.role = patch.role
  if (patch.advertisedCidrs !== undefined) {
    fields.advertisedCidrs = patch.advertisedCidrs
  }
  if (patch.keepalive !== undefined) fields.keepalive = patch.keepalive
  if (patch.endpointAddress !== undefined) {
    fields.endpointAddress = patch.endpointAddress
  }
  if (sealedPresharedKey !== undefined) {
    fields.presharedKey = sealedPresharedKey
  }
  return fields
}

export function resolveSealedRelayPresharedKey(
  presharedKey: string | null | undefined,
  encrypt: ((plaintext: string) => Promise<string>) | null,
): Promise<string | null | undefined> {
  if (presharedKey === undefined) return Promise.resolve(undefined)
  if (presharedKey === null) return Promise.resolve(null)
  if (!encrypt) return Promise.resolve(undefined)
  return encrypt(presharedKey)
}

export function gatewayRelayReadyErrorResponse(
  gatewayError: GatewayRelayReadyError | null,
): Response | null {
  if (!gatewayError) return null
  return Response.json({ error: gatewayError.kind }, { status: 422 })
}

export function gatewayRolePatchErrorResponse(
  role: string,
  gatewayError: GatewayRelayReadyError | null,
): Response | null {
  if (role !== 'gateway') return null
  return gatewayRelayReadyErrorResponse(gatewayError)
}

export function fabricTypedEnqueueErrorResponse(
  results: readonly FabricEnqueueResult[],
): Response | null {
  const enqueueError = fabricEnqueueTypedError(results)
  if (!enqueueError) return null
  return Response.json({ error: enqueueError }, { status: 422 })
}

export async function enqueueRelayPatchReconcile(params: {
  session: { userId: string } | null | undefined
  commandQueue: CommandQueue | Response
  db: Db
  organizationId: string
  secrets: FabricMembershipSecrets
  reconcile: RelayPatchReconcileFn
}): Promise<Response | null> {
  if (params.commandQueue instanceof Response || !params.session) return null
  return fabricTypedEnqueueErrorResponse(
    await params.reconcile({
      db: params.db,
      commandQueue: params.commandQueue,
      actorType: 'user',
      actorId: params.session.userId,
      organizationId: params.organizationId,
      ...params.secrets,
    }),
  )
}

export type FabricRelayObserved = {
  lastHandshakeAt?: string
  transferRx?: number
  transferTx?: number
}

export type FabricRelayApiRow = {
  serverId: string
  address: string
  role: RelayRole
  advertisedCidrs: string[]
  keepalive: number | null
  endpointAddress: string | null
  resolvedEndpoint: string | null
  publicKey: string | null
  prefix: string
  hasPresharedKey: boolean
  segments: FabricSegmentMaterial[]
  observed: FabricRelayObserved | null
}

export function observedForRelay(
  relays: readonly Pick<RelayRecord, 'publicKey' | 'metadata'>[],
  publicKey: string | null,
): FabricRelayObserved | null {
  if (!publicKey) return null
  let latestAt = ''
  let match: FabricRelayObserved | null = null
  for (const row of relays) {
    const observed = row.metadata.observed
    if (!observed?.at || !Array.isArray(observed.peers)) continue
    const peer = observed.peers.find((entry) => entry.publicKey === publicKey)
    if (!peer) continue
    if (latestAt && observed.at <= latestAt) continue
    latestAt = observed.at
    match = {
      ...(peer.lastHandshakeAt
        ? { lastHandshakeAt: peer.lastHandshakeAt }
        : {}),
      ...(peer.transferRx !== undefined ? { transferRx: peer.transferRx } : {}),
      ...(peer.transferTx !== undefined ? { transferTx: peer.transferTx } : {}),
    }
  }
  return match
}

export function resolveRelayEndpointOrNull(
  row: Pick<RelayRecord, 'serverId' | 'endpointAddress'>,
  caches: EndpointAddressCaches,
): string | null {
  try {
    return resolveRelayEndpointAddress(row, caches)
  } catch (err) {
    if (
      err instanceof FabricAllocationError &&
      err.kind === 'relay_endpoint_unavailable'
    ) {
      return null
    }
    throw err
  }
}

export function toFabricRelayApiRow(params: {
  relay: RelayRecord
  hasPresharedKey: boolean
  segments: FabricSegmentMaterial[]
  caches: EndpointAddressCaches
  relays: readonly RelayRecord[]
}): FabricRelayApiRow {
  return {
    serverId: params.relay.serverId,
    address: params.relay.address,
    role: params.relay.role,
    advertisedCidrs: params.relay.advertisedCidrs,
    keepalive: params.relay.keepalive,
    endpointAddress: params.relay.endpointAddress,
    resolvedEndpoint: resolveRelayEndpointOrNull(params.relay, params.caches),
    publicKey: params.relay.publicKey,
    prefix: params.relay.prefix,
    hasPresharedKey: params.hasPresharedKey,
    segments: params.segments,
    observed: observedForRelay(params.relays, params.relay.publicKey),
  }
}

export function fabricSettingsResponse(
  record: FabricRecord | null,
  relays: FabricRelayApiRow[] = [],
): {
  enabled: boolean
  fabric?: { id: string; cidr: string; mtu: number }
  relays: FabricRelayApiRow[]
} {
  if (!record) return { enabled: false, relays: [] }
  const options = parseFabricOptions(record.options)
  return {
    enabled: true,
    fabric: { id: record.id, cidr: record.cidr, mtu: options.mtu },
    relays,
  }
}
