import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { ip, peer, server, vpn } from '../db/schema.ts'
import {
  isValidIpAddress,
  nextFreeHostAddress,
  stripInetPrefixSuffix,
} from '../ip-address.ts'

export type VpnAddressAllocationError =
  | { kind: 'vpn_not_found' }
  | { kind: 'vpn_address_pool_exhausted' }
  | { kind: 'vpn_address_conflict' }
  | { kind: 'vpn_address_out_of_cidr' }

export type VpnTunnelIpResult = {
  ipId: string
  address: string
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

/** True when the unique violation is on overlay VPN address (`uniq_ip_vpn_address`). */
export function isVpnAddressUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_ip_vpn_address')
}

function isAllocationError(
  value: unknown,
): value is VpnAddressAllocationError {
  return typeof value === 'object' && value !== null && 'kind' in value
}

function displayNameForServer(row: {
  displayName: string | null
  hostname: string | null
}): string | undefined {
  const fromDisplay = row.displayName?.trim()
  if (fromDisplay && fromDisplay.length > 0) return fromDisplay.slice(0, 255)
  const fromHostname = row.hostname?.trim()
  if (fromHostname && fromHostname.length > 0) return fromHostname.slice(0, 255)
  return undefined
}

async function insertVpnTunnelIp(
  tx: Db,
  params: {
    organizationId: string
    vpnId: string
    serverId: string
    address: string
    displayName?: string
  },
): Promise<VpnTunnelIpResult> {
  const [inserted] = await tx
    .insert(ip)
    .values({
      organizationId: params.organizationId,
      vpnId: params.vpnId,
      serverId: params.serverId,
      address: params.address,
      allocation: 'dedicated',
      scope: 'vpn',
      ...(params.displayName !== undefined
        ? { displayName: params.displayName }
        : {}),
    })
    .returning({ id: ip.id, address: ip.address })

  return {
    ipId: inserted.id,
    address: stripInetPrefixSuffix(inserted.address),
  }
}

async function loadVpnAndServer(
  tx: Db,
  vpnId: string,
  serverId: string,
): Promise<
  | {
    organizationId: string
    cidr: string
    displayName?: string
  }
  | VpnAddressAllocationError
> {
  const [vpnRow] = await tx
    .select({
      organizationId: vpn.organizationId,
      cidr: vpn.cidr,
    })
    .from(vpn)
    .where(eq(vpn.id, vpnId))
    .limit(1)
  if (!vpnRow) return { kind: 'vpn_not_found' }

  const [serverRow] = await tx
    .select({
      displayName: server.displayName,
      hostname: server.hostname,
    })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)

  return {
    organizationId: vpnRow.organizationId,
    cidr: vpnRow.cidr,
    displayName: serverRow ? displayNameForServer(serverRow) : undefined,
  }
}

/**
 * Read-compute-insert one overlay tunnel IP on an open transaction/client.
 * Used by {@link allocateVpnTunnelIp} and peer-create (same outer transaction).
 */
export async function allocateVpnTunnelIpOnce(
  tx: Db,
  params: {
    vpnId: string
    serverId: string
    displayName?: string
  },
): Promise<VpnTunnelIpResult | VpnAddressAllocationError> {
  const context = await loadVpnAndServer(tx, params.vpnId, params.serverId)
  if (isAllocationError(context)) return context

  const usedRows = await tx
    .select({ address: ip.address })
    .from(ip)
    .where(eq(ip.vpnId, params.vpnId))
  const used = usedRows.map((row) => stripInetPrefixSuffix(row.address))
  const candidate = nextFreeHostAddress(context.cidr, used)
  if (!candidate) return { kind: 'vpn_address_pool_exhausted' }

  return await insertVpnTunnelIp(tx, {
    organizationId: context.organizationId,
    vpnId: params.vpnId,
    serverId: params.serverId,
    address: candidate,
    displayName: params.displayName ?? context.displayName,
  })
}

/**
 * Allocate the lowest free host address in `vpn.cidr` as an overlay
 * `ip(scope='vpn', allocation='dedicated')` row.
 *
 * Concurrency relies on `uniq_ip_vpn_address` (Hyperdrive has no advisory locks):
 * one full-transaction retry on unique violation.
 */
export async function allocateVpnTunnelIp(
  db: Db,
  params: {
    vpnId: string
    serverId: string
    displayName?: string
  },
): Promise<VpnTunnelIpResult | VpnAddressAllocationError> {
  try {
    return await db.transaction(async (tx) => await allocateVpnTunnelIpOnce(tx, params))
  } catch (err) {
    if (!isVpnAddressUniqueViolation(err)) throw err
    try {
      return await db.transaction(async (tx) => await allocateVpnTunnelIpOnce(tx, params))
    } catch (retryErr) {
      if (isVpnAddressUniqueViolation(retryErr)) {
        return { kind: 'vpn_address_pool_exhausted' }
      }
      throw retryErr
    }
  }
}

/**
 * Insert an overlay tunnel IP at an explicit address inside `vpn.cidr`.
 * Re-checks containment with Postgres `<<=` and maps duplicates to
 * `vpn_address_conflict`.
 */
export async function createVpnTunnelIpAt(
  db: Db,
  params: {
    vpnId: string
    serverId: string
    address: string
    displayName?: string
  },
): Promise<VpnTunnelIpResult | VpnAddressAllocationError> {
  const address = stripInetPrefixSuffix(params.address)
  if (!isValidIpAddress(address)) {
    return { kind: 'vpn_address_out_of_cidr' }
  }

  try {
    return await db.transaction(async (tx) => {
      return await createVpnTunnelIpAtOnce(tx, { ...params, address })
    })
  } catch (err) {
    if (isVpnAddressUniqueViolation(err)) {
      return { kind: 'vpn_address_conflict' }
    }
    throw err
  }
}

/** Same as {@link createVpnTunnelIpAt} but on an open transaction/client. */
export async function createVpnTunnelIpAtOnce(
  tx: Db,
  params: {
    vpnId: string
    serverId: string
    address: string
    displayName?: string
  },
): Promise<VpnTunnelIpResult | VpnAddressAllocationError> {
  const address = stripInetPrefixSuffix(params.address)
  if (!isValidIpAddress(address)) {
    return { kind: 'vpn_address_out_of_cidr' }
  }

  const context = await loadVpnAndServer(tx, params.vpnId, params.serverId)
  if (isAllocationError(context)) return context

  const [contained] = await tx
    .select({ id: vpn.id })
    .from(vpn)
    .where(
      and(
        eq(vpn.id, params.vpnId),
        sql`${address}::inet <<= ${vpn.cidr}`,
      ),
    )
    .limit(1)
  if (!contained) return { kind: 'vpn_address_out_of_cidr' }

  return await insertVpnTunnelIp(tx, {
    organizationId: context.organizationId,
    vpnId: params.vpnId,
    serverId: params.serverId,
    address,
    displayName: params.displayName ?? context.displayName,
  })
}

/** True when `address` is inside the VPN overlay CIDR (`<<=`). */
export async function isAddressInVpnCidr(
  db: Db,
  vpnId: string,
  address: string,
): Promise<boolean> {
  const trimmed = stripInetPrefixSuffix(address)
  if (!isValidIpAddress(trimmed)) return false
  const [row] = await db
    .select({ id: vpn.id })
    .from(vpn)
    .where(
      and(
        eq(vpn.id, vpnId),
        sql`${trimmed}::inet <<= ${vpn.cidr}`,
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * Delete an overlay VPN IP only when it is still unreferenced by other peers
 * and still scoped to this VPN.
 */
export async function releaseVpnTunnelIpIfOrphaned(
  db: Db,
  params: {
    vpnId: string
    tunnelIpId: string
  },
): Promise<void> {
  const [stillReferenced] = await db
    .select({ id: peer.id })
    .from(peer)
    .where(
      and(
        eq(peer.vpnId, params.vpnId),
        eq(peer.tunnelIpId, params.tunnelIpId),
      ),
    )
    .limit(1)
  if (stillReferenced) return

  await db
    .delete(ip)
    .where(
      and(
        eq(ip.id, params.tunnelIpId),
        eq(ip.vpnId, params.vpnId),
        eq(ip.scope, 'vpn'),
      ),
    )
}

