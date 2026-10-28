/**
 * Unused registration keys expire. A key minted from Add Server
 * (`POST /licenses`) gets `license.expires_at` = mint time plus
 * {@link LICENSE_KEY_UNUSED_TTL_DAYS}; once that passes while no server has
 * enrolled with it, the key cannot enroll and no longer holds a license (or a
 * seat at the tier it carries). A key already bound to a server never
 * expires, and a key with no `expires_at` (minted before this rule, or the
 * colocated control-plane key) never expires either.
 *
 * Read-time only: nothing sweeps or revokes an expired key, so it stays on the
 * key list as "Expired" until an owner deletes it.
 *
 * Workers-bundleable: nothing at module load.
 */

/** Days an unused registration key stays usable after it is minted. */
export const LICENSE_KEY_UNUSED_TTL_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/** When a key minted at `mintedAtMs` stops working if no server has enrolled with it. */
export function unusedKeyExpiresAt(mintedAtMs: number): string {
  return new Date(mintedAtMs + LICENSE_KEY_UNUSED_TTL_DAYS * DAY_MS).toISOString()
}

export type ExpirableKey = Readonly<{ serverId: string | null; expiresAt: string | null }>

/** An unused key whose expiry has passed: it cannot enroll and holds nothing. */
export function isUnusedKeyExpired(key: ExpirableKey, nowMs: number = Date.now()): boolean {
  if (key.serverId !== null || key.expiresAt === null) return false
  const at = Date.parse(key.expiresAt)
  return Number.isFinite(at) && at <= nowMs
}
