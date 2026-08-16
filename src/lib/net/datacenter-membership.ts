/**
 * Datacenter membership is an `ip` row with
 * `scope='datacenter' AND server_id AND datacenter_id` (optional `network_id`
 * → the site CIDR network). A server may hold many pins (multi-NIC / ranges).
 * Unassign deletes that pin row.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { datacenter, ip, network } from '../db/schema.ts'
import {
  addressInCidr,
  inferSiteCidrFromAddress,
  inetAddressToString,
  isValidCidr,
  isValidIpAddress,
  stripInetPrefixSuffix,
} from '../ip-address.ts'
import {
  parseServerIps,
  privateAddressesFromIps,
  type ServerReportedIp,
} from '../../server-addresses.ts'

export type DatacenterMemberPin = {
  serverId: string
  address: string
}

export type DatacenterMembershipRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
}

export function normalizeReportedPrivateAddresses(
  ips: ServerReportedIp[] | null | undefined,
): string[] {
  return privateAddressesFromIps(ips).filter((address) =>
    isValidIpAddress(address)
  )
}

export function reportedAddressesFromServerMetadata(
  metadata: unknown,
): string[] {
  return normalizeReportedPrivateAddresses(
    parseIpsFromServerMetadata(metadata),
  )
}

export function isReportedPrivateAddress(
  metadata: unknown,
  address: string,
): boolean {
  const normalized = stripInetPrefixSuffix(address.trim())
  return reportedAddressesFromServerMetadata(metadata).includes(normalized)
}

function parseIpsFromServerMetadata(
  metadata: unknown,
): ServerReportedIp[] | undefined {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return undefined
  }
  return parseServerIps((metadata as Record<string, unknown>).ips)
}

function findReportedPrivateIp(
  metadata: unknown,
  address: string,
): ServerReportedIp | null {
  const ips = parseIpsFromServerMetadata(metadata)
  if (!ips) return null
  const normalized = stripInetPrefixSuffix(address.trim())
  return ips.find(
    (row) => row.scope === 'private' && row.address === normalized,
  ) ?? null
}

/**
 * Aligned interface CIDR for a daemon-reported private address.
 * Returns null when the host has not reported a prefix for that IP.
 */
export function reportedCidrForAddress(
  metadata: unknown,
  address: string,
): string | null {
  return findReportedPrivateIp(metadata, address)?.cidr ?? null
}

/**
 * Site CIDR for a daemon-reported private address: the aligned interface
 * prefix when present, otherwise a typical LAN (`/24` IPv4, `/64` IPv6).
 * Returns null when the address is not a reported private IP.
 */
export function siteCidrForAddress(
  metadata: unknown,
  address: string,
): string | null {
  const match = findReportedPrivateIp(metadata, address)
  if (!match) return null
  return match.cidr ?? inferSiteCidrFromAddress(match.address)
}

export function validateMemberPinAddress(
  address: string,
  cidr: string,
  serverMetadata: unknown,
):
  | { ok: true; address: string }
  | {
    ok: false
    error:
      | 'invalid_address'
      | 'invalid_cidr'
      | 'address_not_in_cidr'
      | 'address_not_reported'
  } {
  if (!isValidCidr(cidr.trim())) {
    return { ok: false, error: 'invalid_cidr' }
  }
  const normalized = stripInetPrefixSuffix(address.trim())
  if (!normalized || !isValidIpAddress(normalized)) {
    return { ok: false, error: 'invalid_address' }
  }
  if (!addressInCidr(normalized, cidr.trim())) {
    return { ok: false, error: 'address_not_in_cidr' }
  }
  if (!isReportedPrivateAddress(serverMetadata, normalized)) {
    return { ok: false, error: 'address_not_reported' }
  }
  return { ok: true, address: normalized }
}

export async function loadDatacenterMembershipsForServers(
  db: Db,
  serverIds: string[],
): Promise<Map<string, DatacenterMembershipRow[]>> {
  const byServer = new Map<string, DatacenterMembershipRow[]>()
  if (serverIds.length === 0) return byServer

  const rows = await db
    .select({
      ipId: ip.id,
      serverId: ip.serverId,
      datacenterId: ip.datacenterId,
      networkId: ip.networkId,
      address: ip.address,
    })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        isNotNull(ip.serverId),
        isNotNull(ip.datacenterId),
        inArray(ip.serverId, serverIds),
      ),
    )

  for (const row of rows) {
    if (!row.serverId || !row.datacenterId) continue
    const address = inetAddressToString(row.address)
    if (!address) continue
    const list = byServer.get(row.serverId) ?? []
    list.push({
      ipId: row.ipId,
      serverId: row.serverId,
      datacenterId: row.datacenterId,
      networkId: row.networkId,
      address,
    })
    byServer.set(row.serverId, list)
  }
  return byServer
}

export async function loadDatacenterMembershipsForDatacenter(
  db: Db,
  datacenterId: string,
): Promise<DatacenterMembershipRow[]> {
  const rows = await db
    .select({
      ipId: ip.id,
      serverId: ip.serverId,
      datacenterId: ip.datacenterId,
      networkId: ip.networkId,
      address: ip.address,
    })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        eq(ip.datacenterId, datacenterId),
        isNotNull(ip.serverId),
      ),
    )

  const out: DatacenterMembershipRow[] = []
  for (const row of rows) {
    if (!row.serverId || !row.datacenterId) continue
    const address = inetAddressToString(row.address)
    if (!address) continue
    out.push({
      ipId: row.ipId,
      serverId: row.serverId,
      datacenterId: row.datacenterId,
      networkId: row.networkId,
      address,
    })
  }
  return out
}

/** Shared datacenter ids between two servers (intersection of memberships). */
export function sharedDatacenterIds(
  a: readonly DatacenterMembershipRow[],
  b: readonly DatacenterMembershipRow[],
): string[] {
  const bIds = new Set(b.map((row) => row.datacenterId))
  const shared = a
    .map((row) => row.datacenterId)
    .filter((id) => bIds.has(id))
  return [...new Set(shared)].sort((x, y) => x.localeCompare(y))
}

export async function loadServerDatacenterPinAddress(
  db: Db,
  serverId: string,
  datacenterId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ address: ip.address })
    .from(ip)
    .where(
      and(
        eq(ip.scope, 'datacenter'),
        eq(ip.serverId, serverId),
        eq(ip.datacenterId, datacenterId),
      ),
    )
    .limit(1)
  return inetAddressToString(row?.address) ?? null
}

export async function countUnassignedServersAmong(
  db: Db,
  serverIds: string[],
): Promise<{ memberServerIds: Set<string>; unassignedCount: number }> {
  const memberships = await loadDatacenterMembershipsForServers(db, serverIds)
  const memberServerIds = new Set(memberships.keys())
  let unassignedCount = 0
  for (const id of serverIds) {
    if (!memberServerIds.has(id)) unassignedCount += 1
  }
  return { memberServerIds, unassignedCount }
}

export async function loadDatacenterDisplayNames(
  db: Db,
  datacenterIds: string[],
): Promise<Map<string, string | null>> {
  const byId = new Map<string, string | null>()
  if (datacenterIds.length === 0) return byId
  const rows = await db
    .select({ id: datacenter.id, name: datacenter.name })
    .from(datacenter)
    .where(inArray(datacenter.id, datacenterIds))
  for (const row of rows) {
    byId.set(row.id, row.name)
  }
  return byId
}

export async function loadSiteNetworkId(
  db: Db,
  datacenterId: string,
): Promise<{ networkId: string; cidr: string } | null> {
  const [row] = await db
    .select({
      id: network.id,
      cidr: network.cidr,
    })
    .from(network)
    .where(
      and(
        eq(network.kind, 'datacenter'),
        eq(network.datacenterId, datacenterId),
      ),
    )
    .limit(1)
  if (!row?.cidr) return null
  return { networkId: row.id, cidr: row.cidr }
}
