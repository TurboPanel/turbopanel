/**
 * When an issued certificate is due for renewal if nothing better is known:
 * a third of its lifetime before the end, which keeps working for a 90-day
 * certificate and for the shorter ones to come. Pure date arithmetic with no
 * certificate-authority client, so the Workers build can stamp a renewal time
 * on a certificate without pulling the ACME code into its bundle.
 */

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
