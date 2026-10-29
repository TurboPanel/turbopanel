/**
 * The wait a `Retry-After` header asks for (RFC 9110): a number of seconds or
 * an HTTP date. Returns milliseconds, never more than `maxMs`, or null when
 * the header is absent or unreadable. One reader for every outbound client so
 * the authority and the DNS host are honoured the same way.
 */
export const MAX_RETRY_AFTER_MS = 86_400_000

/** Statuses that mean "slow down": the caller should pause for the stated time. */
export function isThrottleStatus(status: number): boolean {
  return status === 429 || status === 503
}

export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
  maxMs: number = MAX_RETRY_AFTER_MS
): number | null {
  const text = header?.trim()
  if (!text) return null
  const seconds = Number(text)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxMs)
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.min(Math.max(at - nowMs, 0), maxMs)
}

/** `Retry-After` of a response that said to slow down; null for any other status or no header. */
export function throttleWaitMs(response: Response): number | null {
  return isThrottleStatus(response.status)
    ? parseRetryAfterMs(response.headers.get('retry-after'))
    : null
}
