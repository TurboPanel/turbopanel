/**
 * When a DNS-validated certificate is renewed. The authority's own advice
 * (ACME Renewal Information, RFC 9773) wins when it gives any; without it a
 * certificate is renewed when a third of its lifetime is left, which is what
 * keeps working for a 90-day certificate and for the shorter ones to come.
 */
import { fetchRenewalWindow } from '../../../lib/acme/client.ts'
import { acmeDirectoryUrl } from '../../../lib/acme/directories.ts'
import { renewalCertId } from '../../../lib/acme/renewal-id.ts'
import { DAY_MS, clock, type DnsCertContext } from './context.ts'
import type { DnsCertState } from './order-state.ts'

/** The authority is asked again at most this often. */
export const ARI_REFRESH_MS = 6 * 3_600_000
/** Whatever the authority suggests, renewal starts at least this long before the end. */
const LAST_START_BEFORE_END_MS = 2 * DAY_MS

/** A third of the lifetime before the end. */
export function fallbackRenewAt(notBefore: Date, notAfter: Date): Date {
  return new Date(notAfter.getTime() - (notAfter.getTime() - notBefore.getTime()) / 3)
}

function pickInWindow(start: Date, end: Date, random: () => number): Date {
  return new Date(start.getTime() + random() * (end.getTime() - start.getTime()))
}

/**
 * The renewal time to keep: a random moment in the authority's suggested
 * window (never later than two days before the end), or the fallback.
 */
export async function refreshedRenewAt(
  ctx: DnsCertContext,
  state: DnsCertState,
  certificate: { pem: string; notBefore: Date; notAfter: Date },
  random: () => number = Math.random
): Promise<string> {
  const fallback = fallbackRenewAt(certificate.notBefore, certificate.notAfter)
  const certId = renewalCertId(certificate.pem)
  const window = certId
    ? await fetchRenewalWindow({
        directoryUrl: acmeDirectoryUrl(state.staging),
        certId,
        fetch: ctx.acmeFetch,
      })
    : null
  if (!window) return fallback.toISOString()
  const latest = new Date(certificate.notAfter.getTime() - LAST_START_BEFORE_END_MS)
  const picked = pickInWindow(window.start, window.end, random)
  return new Date(Math.min(picked.getTime(), latest.getTime())).toISOString()
}

/** Is the authority due to be asked again about this certificate? */
export function ariDue(ctx: DnsCertContext, state: DnsCertState): boolean {
  if (!state.ariCheckedAt) return true
  return clock(ctx).getTime() - Date.parse(state.ariCheckedAt) >= ARI_REFRESH_MS
}
