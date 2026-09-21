import type { ServerGeo } from './server-geo.ts'

/**
 * Resolves geolocation for self-hosted (Deno) daemon WebSocket connections.
 *
 * **Workers-only today:** Cloudflare Workers populate geo from `request.cf` via
 * `extractCloudflareGeo()` in `src/daemon/workers-ws.ts`. Self-hosted Deno
 * still calls this hook on connect (`src/daemon/deno-ws.ts`) but always returns
 * `null` — there is no bundled IP geolocation database or external lookup on
 * managed/self-hosted installs yet.
 *
 * Co-located dev daemons dial the Unix socket (`__direct__` or loopback) and
 * would not benefit from IP lookup even if enabled. Remote managed servers on
 * Deno receive geo only when fronted by Cloudflare (same Workers path) or when
 * a future MaxMind GeoIP2 / `mmdb` provider is added here.
 *
 * @extensionPoint Future self-hosted implementations should perform a local
 * MaxMind GeoIP2 / `mmdb` lookup keyed on `remoteAddress` (database file under
 * managed config, refreshed by Ansible). Until then, `server.metadata.geo` on
 * Deno-only installs remains empty unless backfilled from a Workers connect.
 */
export function resolveSelfHostedGeo(
  _remoteAddress: string | null | undefined,
): ServerGeo | null {
  // `_remoteAddress` retained for the MaxMind/mmdb extension point above.
  return null // NOSONAR typescript:S3516 — intentional stub until GeoIP2 is wired
}
