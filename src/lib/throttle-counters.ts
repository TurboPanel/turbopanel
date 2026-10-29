/**
 * Counts of "slow down" answers (429 and 503) a sweep tick met, by who said it:
 * the certificate authority or Cloudflare. They ride on the sweep result and in
 * its log line only; nothing is stored.
 */
export type ThrottleKind = 'authority' | 'cloudflare'

export type ThrottleCounters = {
  authority429: number
  authority503: number
  cloudflare429: number
  cloudflare503: number
}

export function emptyThrottleCounters(): ThrottleCounters {
  return { authority429: 0, authority503: 0, cloudflare429: 0, cloudflare503: 0 }
}

/** Count one answer; any status other than 429 and 503 is not a throttle and is ignored. */
export function countThrottle(
  counters: ThrottleCounters | undefined,
  kind: ThrottleKind,
  status: number | null
): void {
  if (!counters || (status !== 429 && status !== 503)) return
  counters[`${kind}${status}`] += 1
}

export function addThrottleCounters(into: ThrottleCounters, from: ThrottleCounters): void {
  for (const key of Object.keys(into) as (keyof ThrottleCounters)[]) into[key] += from[key]
}
