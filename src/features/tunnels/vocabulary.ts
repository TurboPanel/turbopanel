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

/** What a badge (an API token) can do on its carrier. */
export const BADGE_CAPABILITIES = ['tunnels', 'dns', 'certificates'] as const
export type BadgeCapability = (typeof BADGE_CAPABILITIES)[number]

/**
 * `secret.provider` values the sealed tokens are stored under. Neutral on
 * purpose: the vendor lives in `carrier.provider` / `tunnel.provider`, so a new
 * tunnel provider never widens the shared secret check again.
 */
export const TUNNEL_SECRET_PROVIDERS = ['carrier_badge', 'tunnel_run'] as const
export const BADGE_SECRET_PROVIDER = TUNNEL_SECRET_PROVIDERS[0]
export const RUN_SECRET_PROVIDER = TUNNEL_SECRET_PROVIDERS[1]
