import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { fabric, ip, relay } from '../db/schema.ts'
import { inetAddressToString } from '../ip-address.ts'
import {
  loadDatacenterMembershipsForServers,
  sharedDatacenterIds,
  type DatacenterMembershipRow,
} from './datacenter-membership.ts'

export type PrivateEndpointTransport = 'local' | 'datacenter' | 'fabric'

export type ResolvedPrivateEndpoint = {
  address: string
  transport: PrivateEndpointTransport
  /** Present when transport is `datacenter`. */
  datacenterId?: string
  /** Present when transport is `fabric`. */
  fabricId?: string
}

export type PrivateEndpointError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | {
    kind: 'private_path_unavailable'
    fromServerId: string
    toServerId: string
  }

export function isPrivateEndpointError(
  value: unknown,
): value is PrivateEndpointError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/**
 * Map a prepare error to a 422 JSON body with `{ error: kind }` only — never
 * leak id fields on the wire (mirrors managed `prepareErrorResponse`).
 */
export function privateEndpointErrorResponse(
  c: Context,
  error: PrivateEndpointError,
): Response {
  return c.json({ error: error.kind }, 422)
}

/** One membership pin address for a server (oldest first) — any datacenter. */
export async function loadServerDatacenterAddress(
  db: Db,
  serverId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(
      and(
        eq(ip.serverId, serverId),
        eq(ip.scope, 'datacenter'),
        isNotNull(ip.datacenterId),
      ),
    )
    .orderBy(asc(ip.createdAt))
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

type RelayJoinRow = {
  relayId: string
  serverId: string
  fabricId: string
  fabricCreatedAt: string
  address: string
}

/**
 * Relays on fabrics that include at least one of the listed servers.
 * The peer address is `relay.address` (no `ip` join).
 */
async function loadFabricRelayRows(
  db: Db,
  serverIds: string[],
): Promise<RelayJoinRow[]> {
  if (serverIds.length === 0) return []

  const membership = await db
    .select({ fabricId: relay.fabricId })
    .from(relay)
    .where(inArray(relay.serverId, serverIds))

  const fabricIds = [...new Set(membership.map((row) => row.fabricId))]
  if (fabricIds.length === 0) return []

  const rows = await db
    .select({
      relayId: relay.id,
      serverId: relay.serverId,
      fabricId: relay.fabricId,
      fabricCreatedAt: fabric.createdAt,
      address: relay.address,
    })
    .from(relay)
    .innerJoin(fabric, eq(relay.fabricId, fabric.id))
    .where(inArray(relay.fabricId, fabricIds))
    .orderBy(asc(fabric.createdAt))

  const out: RelayJoinRow[] = []
  for (const row of rows) {
    const address = inetAddressToString(row.address) ??
      (typeof row.address === 'string' ? row.address : String(row.address))
    if (!address) continue
    out.push({
      relayId: row.relayId,
      serverId: row.serverId,
      fabricId: row.fabricId,
      fabricCreatedAt: row.fabricCreatedAt,
      address,
    })
  }
  return out
}

function pinAddressForDatacenter(
  pins: readonly DatacenterMembershipRow[],
  datacenterId: string,
): string | null {
  return pins.find((row) => row.datacenterId === datacenterId)?.address ?? null
}

/**
 * Ordered ladder: local → fabric → datacenter.
 * Same-host loopback first; a shared relay mesh takes the cross-host private
 * path; a shared datacenter membership is the fallback when no fabric path exists.
 */
function resolveOneFromCaches(params: {
  fromServerId: string
  toServerId: string
  membershipsByServer: Map<string, DatacenterMembershipRow[]>
  relays: RelayJoinRow[]
}): ResolvedPrivateEndpoint | PrivateEndpointError {
  if (params.fromServerId === params.toServerId) {
    return { address: '127.0.0.1', transport: 'local' }
  }

  const fromFabricIds = new Set(
    params.relays
      .filter((row) => row.serverId === params.fromServerId)
      .map((row) => row.fabricId),
  )
  const sharedOnTo = params.relays
    .filter(
      (row) =>
        row.serverId === params.toServerId && fromFabricIds.has(row.fabricId),
    )
    .sort((a, b) => a.fabricCreatedAt.localeCompare(b.fabricCreatedAt))

  const chosen = sharedOnTo[0]
  if (chosen) {
    return {
      address: chosen.address,
      transport: 'fabric',
      fabricId: chosen.fabricId,
    }
  }

  const fromPins = params.membershipsByServer.get(params.fromServerId) ?? []
  const toPins = params.membershipsByServer.get(params.toServerId) ?? []
  const shared = sharedDatacenterIds(fromPins, toPins)
  const sharedDc = shared[0]
  if (sharedDc) {
    const address = pinAddressForDatacenter(toPins, sharedDc)
    if (!address) {
      return { kind: 'datacenter_ip_required', serverId: params.toServerId }
    }
    return {
      address,
      transport: 'datacenter',
      datacenterId: sharedDc,
    }
  }

  return {
    kind: 'private_path_unavailable',
    fromServerId: params.fromServerId,
    toServerId: params.toServerId,
  }
}

/**
 * Answer "what address does `fromServerId` use to reach `toServerId`?" using
 * transport order local → fabric → datacenter.
 */
export async function resolvePrivateEndpoint(
  db: Db,
  params: Readonly<{ fromServerId: string; toServerId: string }>,
): Promise<ResolvedPrivateEndpoint | PrivateEndpointError> {
  const results = await resolvePrivateEndpoints(db, {
    fromServerId: params.fromServerId,
    toServerIds: [params.toServerId],
  })
  const value = results.get(params.toServerId)
  if (!value) {
    return {
      kind: 'private_path_unavailable',
      fromServerId: params.fromServerId,
      toServerId: params.toServerId,
    }
  }
  return value
}

/**
 * Batched resolver for one source server → many targets (one membership query,
 * one relay join — no N+1).
 */
export async function resolvePrivateEndpoints(
  db: Db,
  params: Readonly<{ fromServerId: string; toServerIds: readonly string[] }>,
): Promise<Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>> {
  const out = new Map<string, ResolvedPrivateEndpoint | PrivateEndpointError>()
  if (params.toServerIds.length === 0) return out

  const uniqueTargets = [...new Set(params.toServerIds)]
  const allServerIds = [...new Set([params.fromServerId, ...uniqueTargets])]

  const [membershipsByServer, relays] = await Promise.all([
    loadDatacenterMembershipsForServers(db, allServerIds),
    loadFabricRelayRows(db, allServerIds),
  ])

  for (const toServerId of uniqueTargets) {
    out.set(
      toServerId,
      resolveOneFromCaches({
        fromServerId: params.fromServerId,
        toServerId,
        membershipsByServer,
        relays,
      }),
    )
  }
  return out
}
