/**
 * The Let's Encrypt agreement an organization accepts, as Let's Encrypt's
 * directory names it now. Read on the TLS settings screen and when it is
 * saved, so it must stay quick: the read gives up after a few seconds, a
 * success is kept for ten minutes and a failure for one, so a slow or
 * unreachable authority costs one short wait a minute at most. Separate
 * processes (Workers isolates) may disagree for up to ten minutes after Let's
 * Encrypt publishes a new agreement; the screen then refreshes and asks again.
 *
 * Holds plain data only (a link and a time), so it is safe to keep across
 * requests on Workers.
 */

import { fetchTermsOfService } from '../../lib/acme/client.ts'
import { ACME_PRODUCTION_DIRECTORY } from '../../lib/acme/directories.ts'

const TERMS_TIMEOUT_MS = 4_000
const TERMS_TTL_MS = 10 * 60_000
const TERMS_FAILURE_TTL_MS = 60_000

/** A reader of the current agreement link; null when it cannot be read. */
export type CurrentAcmeTerms = () => Promise<string | null>

/**
 * A cached reader of the current agreement. `fetchFn` stands in for the
 * network in tests; `now` for the clock. Only settled answers are kept: a read
 * still running belongs to the request that started it (on Workers it may be
 * cancelled with that request), so it is never shared with other requests.
 * A cold cache may therefore read the directory more than once at a time.
 */
export function currentAcmeTermsReader(
  fetchFn?: typeof fetch,
  now: () => number = Date.now
): CurrentAcmeTerms {
  let cached: { url: string | null; until: number } | null = null
  return async () => {
    if (cached && now() < cached.until) return cached.url
    try {
      const url = await fetchTermsOfService({
        directoryUrl: ACME_PRODUCTION_DIRECTORY,
        fetch: fetchFn,
        timeoutMs: TERMS_TIMEOUT_MS,
      })
      cached = { url, until: now() + TERMS_TTL_MS }
      return url
    } catch {
      cached = { url: null, until: now() + TERMS_FAILURE_TTL_MS }
      return null
    }
  }
}
