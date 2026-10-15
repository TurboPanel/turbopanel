/**
 * The addresses behind the per-server "allow external access to the databases
 * on this server" setting (see `external-access.ts`).
 *
 * Two different questions live here and must not be conflated:
 *
 * - **bind**: what the shared ProxySQL compose project publishes on. Setting
 *   off is loopback only; setting on is the all-interfaces wildcard.
 * - **dial**: what a client outside the server is told to connect to: the
 *   main entry of the server's "addresses clients use"
 *   (`features/net/client-addresses.ts`) — never `0.0.0.0`, and never a
 *   one-word Linux hostname.
 */

import type { Db } from '../../db/connection.ts'
import { loadServerClientAddresses } from '../net/client-addresses.ts'
import { mainClientAddressHost, type ServerClientAddresses } from '../net/client-addresses-pure.ts'

/** All-interfaces publish when external access is allowed. */
export const ALL_INTERFACES_BIND = '0.0.0.0' // NOSONAR typescript:S1313 — explicit wildcard bind, not a routable host

/** Loopback publish when it is not: what sites run by a site owner's Linux user dial. */
export const LOOPBACK_BIND = '127.0.0.1' // NOSONAR typescript:S1313 — explicit loopback bind

/**
 * Optional loader for host-free tests. Production callers omit this and the
 * module reads the server's addresses clients use.
 */
export type ManagedAddressLoaders = {
  loadAddresses?: (db: Db, serverId: string) => Promise<ServerClientAddresses>
}

/**
 * The main host a client outside the server dials, or `null` when the server
 * has nothing to give out (no DNS name, no address, and at most a one-word
 * Linux hostname).
 *
 * The entry marked primary wins, then the public side, then the first
 * datacenter. Per-engine port reachability is decided by the endpoint builder
 * (`clientEndpointsForListener`); this is the engine-independent host.
 */
export async function resolveManagedExternalDialHost(
  db: Db,
  serverId: string,
  loaders: ManagedAddressLoaders = {}
): Promise<string | null> {
  const load = loaders.loadAddresses ?? loadServerClientAddresses
  return mainClientAddressHost(await load(db, serverId))
}
