/**
 * TurboFabric desired-state helpers (`fabric` / `relay` / `span`).
 */

import { and, eq, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import { inetAddressToString } from '../ip-address.ts'
import {
  fabric,
  ip,
  network,
  relay,
  server,
  span,
  vpn,
} from './schema.ts'
import {
  composeNetworkHostName,
  hostRoute32,
  nthHostAddress,
  nthSubnet,
  parseFabricOptions,
  pickDefaultFabricHostCidr,
  RELAY_PREFIX_LENGTH,
} from '../fabric/cidr.ts'
import {
  collectSpanningComposeNetworkKeys,
  participatingServerIdsForNetwork,
} from '../fabric/spanning.ts'
import type { ComposeDocument } from '../compose/types.ts'
import type { FabricReconcileCommandPayload } from '../commands/schemas.ts'

export type FabricRecord = {
  id: string
  organizationId: string
  cidr: string
  options: unknown
}

export type RelayRecord = {
  id: string
  fabricId: string
  serverId: string
  fabricIpId: string | null
  publicKey: string | null
  prefix: string
}

async function occupiedCidrs(db: Db, organizationId: string): Promise<string[]> {
  const [networks, vpns, fabrics] = await Promise.all([
    db
      .select({ cidr: network.cidr })
      .from(network)
      .where(and(eq(network.organizationId, organizationId), isNotNull(network.cidr))),
    db
      .select({ cidr: vpn.cidr })
      .from(vpn)
      .where(eq(vpn.organizationId, organizationId)),
    db
      .select({ cidr: fabric.cidr })
      .from(fabric)
      .where(eq(fabric.organizationId, organizationId)),
  ])
  const out: string[] = []
  for (const row of [...networks, ...vpns, ...fabrics]) {
    if (typeof row.cidr === 'string' && row.cidr.length > 0) out.push(row.cidr)
  }
  return out
}

export async function getOrganizationFabric(
  db: Db,
  organizationId: string,
): Promise<FabricRecord | null> {
  const [row] = await db
    .select({
      id: fabric.id,
      organizationId: fabric.organizationId,
      cidr: fabric.cidr,
      options: fabric.options,
    })
    .from(fabric)
    .where(eq(fabric.organizationId, organizationId))
    .limit(1)
  if (!row) return null
  return serializeFabric(row)
}

export async function getFabricById(
  db: Db,
  fabricId: string,
): Promise<FabricRecord | null> {
  const [row] = await db
    .select({
      id: fabric.id,
      organizationId: fabric.organizationId,
      cidr: fabric.cidr,
      options: fabric.options,
    })
    .from(fabric)
    .where(eq(fabric.id, fabricId))
    .limit(1)
  if (!row) return null
  return serializeFabric(row)
}

function serializeFabric(row: {
  id: string
  organizationId: string
  cidr: unknown
  options: unknown
}): FabricRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    cidr: typeof row.cidr === 'string' ? row.cidr : String(row.cidr),
    options: row.options,
  }
}

export async function listFabricRelays(
  db: Db,
  fabricId: string,
): Promise<RelayRecord[]> {
  const rows = await db
    .select({
      id: relay.id,
      fabricId: relay.fabricId,
      serverId: relay.serverId,
      fabricIpId: relay.fabricIpId,
      publicKey: relay.publicKey,
      prefix: relay.prefix,
    })
    .from(relay)
    .where(eq(relay.fabricId, fabricId))

  return rows.map((row) => ({
    id: row.id,
    fabricId: row.fabricId,
    serverId: row.serverId,
    fabricIpId: row.fabricIpId,
    publicKey: row.publicKey,
    prefix: typeof row.prefix === 'string' ? row.prefix : String(row.prefix),
  }))
}

async function nextHostIndex(db: Db, fabricId: string): Promise<number> {
  const rows = await db
    .select({ id: ip.id })
    .from(ip)
    .where(eq(ip.fabricId, fabricId))
  return rows.length
}

async function nextPrefixIndex(db: Db, fabricId: string): Promise<number> {
  const rows = await db
    .select({ id: relay.id })
    .from(relay)
    .where(eq(relay.fabricId, fabricId))
  return rows.length
}

export async function ensureFabricRelays(
  db: Db,
  params: {
    fabric: FabricRecord
    organizationId: string
  },
): Promise<RelayRecord[]> {
  const options = parseFabricOptions(params.fabric.options)
  const orgServers = await db
    .select({ id: server.id })
    .from(server)
    .where(eq(server.organizationId, params.organizationId))

  const existing = await listFabricRelays(db, params.fabric.id)
  const have = new Set(existing.map((row) => row.serverId))
  let hostIndex = await nextHostIndex(db, params.fabric.id)
  let prefixIndex = await nextPrefixIndex(db, params.fabric.id)

  for (const row of orgServers) {
    if (have.has(row.id)) continue
    const address = nthHostAddress(params.fabric.cidr, hostIndex)
    const prefix = nthSubnet(options.containerPool, RELAY_PREFIX_LENGTH, prefixIndex)
    hostIndex += 1
    prefixIndex += 1
    if (!address || !prefix) {
      throw new Error('TurboFabric address pool exhausted')
    }

    const [ipRow] = await db
      .insert(ip)
      .values({
        organizationId: params.organizationId,
        serverId: row.id,
        fabricId: params.fabric.id,
        address,
        allocation: 'dedicated',
        scope: 'fabric',
      })
      .returning({ id: ip.id })
    if (!ipRow) throw new Error('TurboFabric ip insert failed')

    await db.insert(relay).values({
      fabricId: params.fabric.id,
      serverId: row.id,
      fabricIpId: ipRow.id,
      prefix,
    })
  }

  return listFabricRelays(db, params.fabric.id)
}

export async function enableOrganizationFabric(
  db: Db,
  organizationId: string,
): Promise<FabricRecord> {
  const existing = await getOrganizationFabric(db, organizationId)
  if (existing) {
    await ensureFabricRelays(db, { fabric: existing, organizationId })
    return existing
  }

  const cidr = pickDefaultFabricHostCidr(await occupiedCidrs(db, organizationId))
  if (!cidr) {
    throw new Error('No free CIDR for TurboFabric')
  }

  const [row] = await db
    .insert(fabric)
    .values({
      organizationId,
      cidr,
      options: parseFabricOptions(null),
    })
    .returning({
      id: fabric.id,
      organizationId: fabric.organizationId,
      cidr: fabric.cidr,
      options: fabric.options,
    })
  if (!row) throw new Error('TurboFabric insert failed')

  const record: FabricRecord = {
    id: row.id,
    organizationId: row.organizationId,
    cidr: typeof row.cidr === 'string' ? row.cidr : String(row.cidr),
    options: row.options,
  }
  await ensureFabricRelays(db, { fabric: record, organizationId })
  return record
}

export async function disableOrganizationFabric(
  db: Db,
  organizationId: string,
): Promise<string[]> {
  const existing = await getOrganizationFabric(db, organizationId)
  if (!existing) return []
  const relays = await listFabricRelays(db, existing.id)
  const serverIds = relays.map((row) => row.serverId)
  await db.delete(fabric).where(eq(fabric.id, existing.id))
  return serverIds
}

export async function stampRelayPublicKey(
  db: Db,
  params: { fabricId: string; serverId: string; publicKey: string },
): Promise<boolean> {
  const [existing] = await db
    .select({ publicKey: relay.publicKey })
    .from(relay)
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    )
    .limit(1)
  if (!existing) return false
  const filledNullKey = !existing.publicKey
  await db
    .update(relay)
    .set({ publicKey: params.publicKey, updatedAt: nowIso() })
    .where(
      and(
        eq(relay.fabricId, params.fabricId),
        eq(relay.serverId, params.serverId),
      ),
    )
  return filledNullKey
}

async function loadEndpointAddress(
  db: Db,
  serverId: string,
): Promise<string | undefined> {
  const [datacenterRow] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'datacenter')))
    .limit(1)
  const datacenter = datacenterRow ? inetAddressToString(datacenterRow.address) : undefined
  if (datacenter) return datacenter

  const [publicRow] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(and(eq(ip.serverId, serverId), eq(ip.scope, 'public')))
    .limit(1)
  return publicRow ? inetAddressToString(publicRow.address) : undefined
}

export async function loadRelayFabricAddress(
  db: Db,
  fabricIpId: string | null,
): Promise<string | null> {
  if (!fabricIpId) return null
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(eq(ip.id, fabricIpId))
    .limit(1)
  return row ? inetAddressToString(row.address) ?? null : null
}

export async function listServerSpans(
  db: Db,
  serverId: string,
): Promise<Array<{ name: string; subnet: string }>> {
  const rows = await db
    .select({
      networkId: span.networkId,
      cidr: span.cidr,
    })
    .from(span)
    .where(eq(span.serverId, serverId))

  return rows.map((row) => ({
    name: composeNetworkHostName(row.networkId),
    subnet: typeof row.cidr === 'string' ? row.cidr : String(row.cidr),
  }))
}

export async function buildFabricReconcilePayload(
  db: Db,
  params: { fabric: FabricRecord; serverId: string },
): Promise<FabricReconcileCommandPayload | null> {
  const relays = await listFabricRelays(db, params.fabric.id)
  const self = relays.find((row) => row.serverId === params.serverId)
  if (!self) return null

  const address = await loadRelayFabricAddress(db, self.fabricIpId)
  if (!address) return null
  const host32 = hostRoute32(address)
  if (!host32) return null

  const options = parseFabricOptions(params.fabric.options)
  const peers: Extract<FabricReconcileCommandPayload, { enabled: true }>['peers'] = []
  for (const other of relays) {
    if (other.serverId === params.serverId) continue
    if (!other.publicKey) continue
    const otherAddress = await loadRelayFabricAddress(db, other.fabricIpId)
    const other32 = otherAddress ? hostRoute32(otherAddress) : null
    const allowedIPs = [other32, other.prefix].filter(
      (value): value is string => typeof value === 'string',
    )
    if (allowedIPs.length === 0) continue
    const endpointHost = await loadEndpointAddress(db, other.serverId)
    const peer: (typeof peers)[number] = {
      publicKey: other.publicKey,
      allowedIPs,
    }
    if (endpointHost) {
      peer.endpoint = `${endpointHost}:${String(options.listenPort)}`
    }
    peers.push(peer)
  }

  const networks = await listServerSpans(db, params.serverId)
  return {
    enabled: true,
    fabricId: params.fabric.id,
    listenPort: options.listenPort,
    address: host32,
    prefix: self.prefix,
    peers,
    ...(networks.length > 0 ? { networks } : {}),
  }
}

export async function ensureComposeNetworkRow(
  db: Db,
  params: {
    organizationId: string
    environmentId: string
    composeKey: string
  },
): Promise<{ id: string; hostName: string }> {
  const existing = await db
    .select({ id: network.id, options: network.options })
    .from(network)
    .where(
      and(
        eq(network.organizationId, params.organizationId),
        eq(network.kind, 'compose'),
        eq(network.environmentId, params.environmentId),
      ),
    )

  for (const row of existing) {
    const options = isOptionsRecord(row.options) ? row.options : {}
    if (options.composeKey === params.composeKey) {
      const hostName = typeof options.dockerNetworkName === 'string'
        ? options.dockerNetworkName
        : composeNetworkHostName(row.id)
      return { id: row.id, hostName }
    }
  }

  const [row] = await db
    .insert(network)
    .values({
      organizationId: params.organizationId,
      kind: 'compose',
      environmentId: params.environmentId,
      name: params.composeKey,
      options: { composeKey: params.composeKey },
    })
    .returning({ id: network.id })
  if (!row) throw new Error('compose network insert failed')

  const hostName = composeNetworkHostName(row.id)
  await db
    .update(network)
    .set({
      options: { composeKey: params.composeKey, dockerNetworkName: hostName },
      updatedAt: nowIso(),
    })
    .where(eq(network.id, row.id))
  return { id: row.id, hostName }
}

function isOptionsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function ensureNetworkSpan(
  db: Db,
  params: {
    networkId: string
    serverId: string
    cidr: string
  },
): Promise<void> {
  await db
    .insert(span)
    .values({
      networkId: params.networkId,
      serverId: params.serverId,
      cidr: params.cidr,
    })
    .onConflictDoNothing({
      target: [span.networkId, span.serverId],
    })
}

export async function materializeSpanningNetworks(
  db: Db,
  params: {
    organizationId: string
    environmentId: string
    fabric: FabricRecord
    document: ComposeDocument
    tasks: ReadonlyArray<{ serviceId: string; serverId: string }>
    serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>
  },
): Promise<Map<string, string>> {
  const keys = collectSpanningComposeNetworkKeys(
    params.document,
    params.tasks,
    params.serviceRows,
  )
  const spanning = new Map<string, string>()
  if (keys.length === 0) return spanning

  await ensureFabricRelays(db, {
    fabric: params.fabric,
    organizationId: params.organizationId,
  })
  const relays = await listFabricRelays(db, params.fabric.id)
  const relayByServer = new Map(relays.map((row) => [row.serverId, row]))

  for (const composeKey of keys) {
    const networkRow = await ensureComposeNetworkRow(db, {
      organizationId: params.organizationId,
      environmentId: params.environmentId,
      composeKey,
    })
    spanning.set(composeKey, networkRow.hostName)

    const serverIds = participatingServerIdsForNetwork(
      params.document,
      params.tasks,
      params.serviceRows,
      composeKey,
    )
    for (const serverId of serverIds) {
      const relayRow = relayByServer.get(serverId)
      if (!relayRow) continue
      const [have] = await db
        .select({ id: span.id })
        .from(span)
        .where(
          and(
            eq(span.networkId, networkRow.id),
            eq(span.serverId, serverId),
          ),
        )
        .limit(1)
      if (have) continue
      const existing = await db
        .select({ id: span.id })
        .from(span)
        .where(eq(span.serverId, serverId))
      const cidr = nthSpanSubnet(relayRow.prefix, existing.length)
      if (!cidr) continue
      await ensureNetworkSpan(db, {
        networkId: networkRow.id,
        serverId,
        cidr,
      })
    }
  }
  return spanning
}

export function nthSpanSubnet(relayPrefix: string, index: number): string | null {
  return nthSubnet(relayPrefix, 24, index)
}
