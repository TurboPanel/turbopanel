/**
 * Fixed value sets for the tunnel tables. `schema.ts` carries the same lists
 * as CHECK constraints; `src/db/enum-checks.test.ts` pins the two together.
 * Adding a provider or a traffic kind is one new member here and in the
 * matching CHECK (widened with a forward migration).
 */

/** Providers a carrier and a tunnel can belong to. */
export const TUNNEL_PROVIDERS = ['cloudflare'] as const
export type TunnelProvider = (typeof TUNNEL_PROVIDERS)[number]

/** Health of a carrier or one of its badges. */
export const CARRIER_STATUSES = ['active', 'attention'] as const
export type CarrierStatus = (typeof CARRIER_STATUSES)[number]

/** Where a tunnel's connectors run: one server, chosen servers, or every server of a datacenter. */
export const TUNNEL_PLACEMENTS = ['one', 'chosen', 'all'] as const
export type TunnelPlacement = (typeof TUNNEL_PLACEMENTS)[number]

export const TUNNEL_STATUSES = ['pending', 'active', 'attention', 'removing'] as const
export type TunnelStatus = (typeof TUNNEL_STATUSES)[number]

/**
 * A server's part in a tunnel: `run` carries a connector, `skip` leaves the
 * server out of an `all` tunnel.
 */
export const PORTAL_WANTED_STATES = ['run', 'skip'] as const
/** What the server last reported for one connector. */
export const PORTAL_REPORTED_STATES = ['unknown', 'connected', 'down', 'error'] as const

/** Kinds of traffic a doorway carries. Only web traffic for now. */
export const DOORWAY_KINDS = ['http'] as const
export type DoorwayKind = (typeof DOORWAY_KINDS)[number]

export const DOORWAY_STATUSES = ['pending', 'live', 'attention', 'removing'] as const

/**
 * What a badge (an API token) can do on its carrier. A tunnel belongs to the
 * account, so `tunnels` is one account-wide yes or no. DNS and certificate
 * rights can be limited to some zones, so those are the zones (id and name)
 * the token was found to reach.
 */
export const BADGE_CAPABILITIES = ['tunnels', 'dns', 'certificates'] as const
export type BadgeCapabilities = {
  tunnels: boolean
  dns: { id: string; name: string }[]
  certificates: { id: string; name: string }[]
}
export const NO_CAPABILITIES: BadgeCapabilities = { tunnels: false, dns: [], certificates: [] }

/**
 * A zone the person says a token covers. A token limited to one zone is often
 * refused the zone list, so the person names the zone (its id is what the
 * provider checks; the name is for matching hostnames and for display).
 */
export type DeclaredZone = { id: string; name: string }

/**
 * `secret.provider` values the sealed tokens are stored under. Neutral on
 * purpose: the vendor lives in `carrier.provider` / `tunnel.provider`, so a new
 * tunnel provider never widens the shared secret check again.
 */
export const TUNNEL_SECRET_PROVIDERS = ['carrier_badge', 'tunnel_run'] as const
export const BADGE_SECRET_PROVIDER = TUNNEL_SECRET_PROVIDERS[0]
export const RUN_SECRET_PROVIDER = TUNNEL_SECRET_PROVIDERS[1]

/** Who owns an API token at the provider: one account, or a person who may reach several. */
export type TokenKind = 'account' | 'user'

/** What the provider says about a token itself, from its verify endpoint. */
export type TokenInfo = {
  kind: TokenKind | null
  /** The provider's own id for the token (not the secret). */
  id: string | null
  status: string | null
  expiresAt: string | null
}
export const UNKNOWN_TOKEN: TokenInfo = { kind: null, id: null, status: null, expiresAt: null }
