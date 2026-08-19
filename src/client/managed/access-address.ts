/**
 * Resolve a {@link ManagedSqlAccessScope} to a concrete address.
 *
 * Two different questions live here and must not be conflated:
 *
 * - **bind**: what the shared ProxySQL compose project publishes on. `public`
 *   is the all-interfaces wildcard.
 * - **dial**: what a client is told to connect to. `public` is a routable host
 *   (pinned public address, else the server hostname) — never `0.0.0.0`.
 *
 * Managed SQL deliberately does not reuse `resolveHostingBindAddress`: that
 * helper speaks the three-value hosting ladder and has no TurboFabric branch.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { server } from '../../lib/db/schema.ts'
import type { ManagedSqlAccessScope } from '../../lib/managed/access-scope.ts'
import {
  loadServerDatacenterAddress,
  loadServerFabricAddress,
  loadServerPublicAddress,
} from '../../lib/net/private-endpoint.ts'

/** All-interfaces publish for `public` scope. */
export const ALL_INTERFACES_BIND = '0.0.0.0' // NOSONAR typescript:S1313 — explicit wildcard bind, not a routable host

/** Loopback publish for `local` scope. */
export const LOOPBACK_BIND = '127.0.0.1' // NOSONAR typescript:S1313 — explicit loopback bind

export type ManagedAccessAddressError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'fabric_address_required'; serverId: string }

export function isManagedAccessAddressError(
  value: unknown,
): value is ManagedAccessAddressError {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'datacenter_ip_required' || kind === 'fabric_address_required'
}

/**
 * Host address the ProxySQL frontend publishes on for one scope.
 *
 * A scope that cannot resolve is an **error, not a fallback**: quietly widening
 * a `turbofabric` cluster to `0.0.0.0` (or narrowing it to loopback) is the kind
 * of surprise that turns a private database into a public one.
 */
export async function resolveManagedBindAddress(
  db: Db,
  params: Readonly<{ serverId: string; scope: ManagedSqlAccessScope }>,
): Promise<string | ManagedAccessAddressError> {
  switch (params.scope) {
    case 'local':
      return LOOPBACK_BIND
    case 'datacenter': {
      const address = await loadServerDatacenterAddress(db, params.serverId)
      if (!address) {
        return { kind: 'datacenter_ip_required', serverId: params.serverId }
      }
      return address
    }
    case 'turbofabric': {
      const address = await loadServerFabricAddress(db, params.serverId)
      if (!address) {
        return { kind: 'fabric_address_required', serverId: params.serverId }
      }
      return address
    }
    case 'public':
      return ALL_INTERFACES_BIND
  }
}

/**
 * Host a client dials for one scope, or `null` when this server has no address
 * for it (the endpoint simply is not offered).
 *
 * `public` prefers a pinned public `ip` row and falls back to the server
 * hostname, which is the stable operator dial even behind DNAT.
 */
export async function resolveManagedDialHost(
  db: Db,
  params: Readonly<{ serverId: string; scope: ManagedSqlAccessScope }>,
): Promise<string | null> {
  switch (params.scope) {
    case 'local':
      return LOOPBACK_BIND
    case 'datacenter':
      return await loadServerDatacenterAddress(db, params.serverId)
    case 'turbofabric':
      return await loadServerFabricAddress(db, params.serverId)
    case 'public': {
      const pinned = await loadServerPublicAddress(db, params.serverId)
      if (pinned) return pinned
      const [row] = await db
        .select({ hostname: server.hostname })
        .from(server)
        .where(eq(server.id, params.serverId))
        .limit(1)
      return row?.hostname?.trim() || null
    }
  }
}
