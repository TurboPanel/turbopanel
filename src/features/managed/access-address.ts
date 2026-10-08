/**
 * The addresses behind the per-server "allow external access to the databases
 * on this server" setting (see `external-access.ts`).
 *
 * Two different questions live here and must not be conflated:
 *
 * - **bind**: what the shared ProxySQL compose project publishes on. Setting
 *   off is loopback only; setting on is the all-interfaces wildcard.
 * - **dial**: what a client outside the server is told to connect to. A
 *   routable host (pinned public address, else the server hostname) — never
 *   `0.0.0.0`.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { server } from '../../db/schema.ts'
import { loadServerPublicAddress } from '../net/private-endpoint.ts'

/** All-interfaces publish when external access is allowed. */
export const ALL_INTERFACES_BIND = '0.0.0.0' // NOSONAR typescript:S1313 — explicit wildcard bind, not a routable host

/** Loopback publish when it is not: what sites run by a site owner's Linux user dial. */
export const LOOPBACK_BIND = '127.0.0.1' // NOSONAR typescript:S1313 — explicit loopback bind

/**
 * Optional loaders for host-free tests. Production callers omit this and the
 * module uses the private-endpoint helper plus a hostname column read.
 */
export type ManagedAddressLoaders = {
  loadPublicAddress?: typeof loadServerPublicAddress
  loadHostname?: (db: Db, serverId: string) => Promise<string | null>
}

async function loadServerHostname(db: Db, serverId: string): Promise<string | null> {
  const [row] = await db
    .select({ hostname: server.hostname })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  return row?.hostname?.trim() || null
}

/**
 * Host a client outside the server dials, or `null` when the server has
 * neither a pinned public address nor a hostname.
 *
 * Prefers a pinned public `ip` row and falls back to the server hostname,
 * which is the stable dial even behind DNAT.
 */
export async function resolveManagedExternalDialHost(
  db: Db,
  serverId: string,
  loaders: ManagedAddressLoaders = {}
): Promise<string | null> {
  const loadPublic = loaders.loadPublicAddress ?? loadServerPublicAddress
  const loadHostname = loaders.loadHostname ?? loadServerHostname
  const pinned = await loadPublic(db, serverId)
  if (pinned) return pinned
  return await loadHostname(db, serverId)
}
