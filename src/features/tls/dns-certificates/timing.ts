/**
 * When a DNS-validated certificate is renewed. The authority's own advice
 * (ACME Renewal Information, RFC 9773) wins when it gives any; without it a
 * certificate is renewed when a third of its lifetime is left, which is what
 * keeps working for a 90-day certificate and for the shorter ones to come.
 * The authority is asked again no sooner than its own `Retry-After` (kept
 * between a minute and twelve hours), which comes to two to four asks a day.
 */
import { fetchRenewalInfo, type RenewalInfo } from '../../../lib/acme/client.ts'
import { acmeDirectoryUrl } from '../../../lib/acme/directories.ts'
import { renewalCertId } from '../../../lib/acme/renewal-id.ts'
import { DAY_MS, clock, type DnsCertContext } from './context.ts'
import type { DnsCertState } from './order-state.ts'

/** Shortest wait the authority's `Retry-After` may set (RFC 9773), and the longest we accept: never fewer than two asks a day. */
export const ARI_MIN_WAIT_MS = 60_000
export const ARI_MAX_WAIT_MS = 12 * 3_600_000
/** Without a `Retry-After`: twice a day, inside the two to four checks a day aimed for. */
export const ARI_DEFAULT_WAIT_MS = 12 * 3_600_000
/** After a failed ask (outage, 429 or 503 without a wait): four times a day at most. */
export const ARI_ERROR_WAIT_MS = 6 * 3_600_000
/** Whatever the authority suggests, renewal starts at least this long before the end. */
const LAST_START_BEFORE_END_MS = 2 * DAY_MS

/** A third of the lifetime before the end. */
export function fallbackRenewAt(notBefore: Date, notAfter: Date): Date {
  return new Date(notAfter.getTime() - (notAfter.getTime() - notBefore.getTime()) / 3)
}

/** How much of the lifetime, before the one-third mark, the fallback may be spread over. */
const FALLBACK_SPREAD = 0.1

/**
 * The fallback with a random head start of up to a tenth of the lifetime, so
 * certificates issued together (a bulk order, a restore) do not all renew on
 * the same day. It is stored with the certificate and not drawn again.
 */
export function jitteredFallbackRenewAt(
  notBefore: Date,
  notAfter: Date,
  random: () => number = Math.random
): Date {
  const lifetime = notAfter.getTime() - notBefore.getTime()
  const base = fallbackRenewAt(notBefore, notAfter)
  return new Date(base.getTime() - random() * lifetime * FALLBACK_SPREAD)
}

function pickInWindow(start: Date, end: Date, random: () => number): Date {
  return new Date(start.getTime() + random() * (end.getTime() - start.getTime()))
}

/** The next time the authority may be asked: its own wait less a little spread, then kept between a minute and twelve hours. */
export function nextAriCheckAt(
  now: Date,
  info: Pick<RenewalInfo, 'answered' | 'retryAfterMs'>,
  random: () => number = Math.random
): string {
  const asked = info.retryAfterMs ?? (info.answered ? ARI_DEFAULT_WAIT_MS : ARI_ERROR_WAIT_MS)
  // Up to a tenth sooner, so certificates ordered together do not all ask together;
  // the clamp comes last so the wait never exceeds twelve hours.
  const spread = asked * (1 - random() * 0.1)
  const wait = Math.min(Math.max(spread, ARI_MIN_WAIT_MS), ARI_MAX_WAIT_MS)
  return new Date(now.getTime() + wait).toISOString()
}

export type RenewalTiming = {
  renewAt: string
  /** Not before this is the authority asked again. */
  nextCheckAt: string
  /** What the authority answered, for the caller's counters. */
  info: RenewalInfo
}

/**
 * The renewal time to keep and when to ask again: a random moment in the
 * authority's suggested window (never later than two days before the end), or
 * a fallback spread over a tenth of the lifetime. Without advice, `keep` (the
 * time already stored) stays rather than being drawn again.
 */
export async function refreshedRenewAt(
  ctx: DnsCertContext,
  state: DnsCertState,
  certificate: { pem: string; notBefore: Date; notAfter: Date },
  options: { keep?: string | null; random?: () => number } = {}
): Promise<RenewalTiming> {
  const random = options.random ?? Math.random
  const certId = renewalCertId(certificate.pem)
  const info: RenewalInfo = certId
    ? await fetchRenewalInfo({
        directoryUrl: acmeDirectoryUrl(state.staging),
        certId,
        fetch: ctx.acmeFetch,
      })
    : { window: null, answered: true, retryAfterMs: null, status: null }
  const nextCheckAt = nextAriCheckAt(clock(ctx), info, random)
  if (!info.window) {
    // No advice: the time already stored stands (it was spread when first chosen).
    const fallback = jitteredFallbackRenewAt(certificate.notBefore, certificate.notAfter, random)
    return { renewAt: options.keep ?? fallback.toISOString(), nextCheckAt, info }
  }
  const latest = new Date(certificate.notAfter.getTime() - LAST_START_BEFORE_END_MS)
  const picked = pickInWindow(info.window.start, info.window.end, random)
  const renewAt = new Date(Math.min(picked.getTime(), latest.getTime())).toISOString()
  return { renewAt, nextCheckAt, info }
}

/** Is the authority due to be asked again about this certificate? */
export function ariDue(ctx: DnsCertContext, state: DnsCertState): boolean {
  if (!state.ariNextCheckAt) return true
  return clock(ctx).getTime() >= Date.parse(state.ariNextCheckAt)
}
