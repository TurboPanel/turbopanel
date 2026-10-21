/**
 * The addresses behind the per-server "allow external access to the databases
 * on this server" setting (see `external-access.ts`).
 *
 * Two different questions live here and must not be conflated:
 *
 * - **bind**: what the shared ProxySQL compose project publishes on. Setting
 *   off is loopback only; setting on is the all-interfaces wildcard, plus the
 *   IPv6 one on a server that has IPv6.
 * - **dial**: what a client outside the server is told to connect to: the
 *   server's "addresses clients use" (`features/net/client-addresses.ts`,
 *   read by `routes-helpers.ts` and `ingress-desired.ts`) — never `0.0.0.0`,
 *   and never a one-word Linux hostname.
 */

/** All-interfaces publish when external access is allowed. */
export const ALL_INTERFACES_BIND = '0.0.0.0' // NOSONAR typescript:S1313 — explicit wildcard bind, not a routable host

/** Every IPv6 address of the server, next to {@link ALL_INTERFACES_BIND}. */
export const ALL_INTERFACES_IPV6_BIND = '::' // NOSONAR typescript:S1313 — explicit IPv6 wildcard bind, not a routable host

/** Loopback publish when it is not: what sites run by a site owner's Linux user dial. */
export const LOOPBACK_BIND = '127.0.0.1' // NOSONAR typescript:S1313 — explicit loopback bind
