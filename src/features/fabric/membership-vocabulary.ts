/**
 * TurboFabric membership vocabulary, pinned to the `server_fabric_role_check`
 * and `relay_kind_check` constraints by `src/db/enum-checks.test.ts`.
 */

/**
 * A server's role in the mesh. A `gateway` has a public (or forwarded) address
 * and accepts connections; a `client` only dials out. Distinct from
 * `relay.role`, which says whether a member shares its datacenter LAN ranges.
 */
export const FABRIC_SERVER_ROLES = ['gateway', 'client'] as const
export type FabricServerRole = (typeof FABRIC_SERVER_ROLES)[number]

/** Kind of mesh peer. Only `server` is built; `external` is reserved. */
export const FABRIC_PEER_KINDS = ['server', 'external'] as const
export type FabricPeerKind = (typeof FABRIC_PEER_KINDS)[number]

export function isFabricServerRole(value: unknown): value is FabricServerRole {
  return typeof value === 'string' && (FABRIC_SERVER_ROLES as readonly string[]).includes(value)
}
