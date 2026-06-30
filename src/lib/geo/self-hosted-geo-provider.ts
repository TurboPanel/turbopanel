import type { ServerGeo } from './server-geo.ts'

/**
 * Resolves geolocation for self-hosted (Deno) daemon connections from the remote
 * IP address.
 *
 * @extensionPoint Future implementations should perform a MaxMind GeoIP2 /
 * `mmdb` lookup keyed on `remoteAddress` (local database file under managed
 * config, refreshed by Ansible). Self-hosted geolocation is intentionally
 * disabled in this phase — no MaxMind dependency or lookup logic is added now.
 */
export function resolveSelfHostedGeo(
  remoteAddress: string | null | undefined,
): ServerGeo | null {
  if (remoteAddress == null || remoteAddress.trim().length === 0) {
    return null
  }

  return null
}
