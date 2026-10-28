/**
 * The pusher login a git webhook names, made safe to store and show.
 *
 * A leaf module on purpose: the webhook parsers, the trigger and the
 * deployment-history reader all clean the same value, and none of them should
 * pull the provider registry in to do it.
 */

/** Longest pusher login kept; longer values are cut, never rejected. */
export const PUSH_LOGIN_MAX_LENGTH = 100

/**
 * A pusher login from an untrusted webhook payload (or stored metadata), safe
 * to keep and show: a string only, control and invisible formatting characters
 * removed, trimmed, and capped at {@link PUSH_LOGIN_MAX_LENGTH}. Anything else,
 * or nothing left, is `null`.
 */
export function pushLoginFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replaceAll(/[\p{Cc}\p{Cf}]/gu, '').trim()
  if (cleaned.length === 0) return null
  return Array.from(cleaned).slice(0, PUSH_LOGIN_MAX_LENGTH).join('').trim()
}
