/**
 * When to renew: a random moment inside the window the authority suggests
 * (ARI, RFC 9773), which also exempts the renewal from rate limits. Without
 * an answer, a third of the lifetime before expiry, and never later than a
 * week before it.
 */
import { fetchRenewalInfo } from '../../../../lib/acme/client.ts'
import { renewalCertId } from '../../../../lib/acme/renewal-id.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const MIN_LEAD_MS = 7 * DAY_MS

/** Pure fallback when the authority gives no window. */
export function fallbackRenewAt(issuedAt: Date, notAfter: Date): Date {
  const lifetime = Math.max(0, notAfter.getTime() - issuedAt.getTime())
  const lead = Math.max(lifetime / 3, MIN_LEAD_MS)
  return new Date(Math.max(issuedAt.getTime(), notAfter.getTime() - lead))
}

/** A uniform random time inside the window. */
export function pickInWindow(start: Date, end: Date, random: () => number): Date {
  return new Date(start.getTime() + random() * Math.max(0, end.getTime() - start.getTime()))
}

export async function planRenewal(input: {
  certPem: string
  issuedAt: Date
  notAfter: Date
  directoryUrl: string
  fetch: typeof fetch
  random: () => number
}): Promise<{ renewAt: Date; replaces: string | null }> {
  const replaces = renewalCertId(input.certPem)
  if (replaces) {
    const info = await fetchRenewalInfo({
      directoryUrl: input.directoryUrl,
      certId: replaces,
      fetch: input.fetch,
    })
    if (info.window) {
      return { renewAt: pickInWindow(info.window.start, info.window.end, input.random), replaces }
    }
  }
  return { renewAt: fallbackRenewAt(input.issuedAt, input.notAfter), replaces }
}
