import type { Db } from '../../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../../lib/secrets/secrets.ts'
import type { TunnelAdapterRegistry } from '../../tunnels/registry.ts'
import type { TunnelProvider } from '../../tunnels/vocabulary.ts'
import type { ThrottleCounters } from '../../../lib/throttle-counters.ts'
import type { DnsChallengeProvider } from './dns-provider.ts'

/** Everything a step needs. Tests replace the fetch, the DNS host and the clock. */
export type DnsCertContext = {
  db: Db
  /** Seals and opens the account key, the certificate key and the provider token. */
  secrets: DerivedSecretsConfig
  /** Finds the zone of a name among the zones a token reaches. */
  adapters: TunnelAdapterRegistry
  /** The DNS host for one provider and token. */
  dns: (provider: TunnelProvider, token: string) => DnsChallengeProvider
  /** The certificate authority's HTTP client. */
  acmeFetch?: typeof fetch
  now?: () => Date
  /** Where a sweep tick counts the 429 and 503 answers it meets. */
  counters?: ThrottleCounters
  /** How long the records are given to reach the authority's resolvers (tests shorten it). */
  presentGraceMs?: number
  /** Told when a renewed certificate replaced the old one, so the sites pinning it can be refreshed. */
  onRenewed?: (tlsId: string, organizationId: string) => Promise<void>
}

export const DAY_MS = 86_400_000
/** A record made for a challenge and still listed after this long is removed by the sweep. */
export const RECORD_KEEP_MS = 2 * 3_600_000
/** The records are given a moment to reach the authority's resolvers before it looks. */
export const PRESENT_GRACE_MS = 10_000
/**
 * A record not yet seen through the DNS host's API is looked at again after
 * this long, not every tick: 25 certificates of ten names on one token then
 * cost at most about 625 reads in five minutes, well under Cloudflare's 1,200.
 */
export const READBACK_RETRY_MS = 2 * 60_000
/**
 * An order still pending this long after its challenges were answered has its
 * authorizations read (at most once per this long): a challenge the authority
 * still holds as pending is answered again, and a failed one stops the order.
 */
export const ANSWER_RECHECK_MS = 30_000
/** One step may hold a certificate this long before another worker may take it. */
export const CLAIM_MS = 90_000
/** An order that has not finished by now is dropped and started over after a wait. */
export const ORDER_TIMEOUT_MS = 30 * 60_000
/** A first certificate gives up after this many failed orders. */
export const MAX_ATTEMPTS = 3
/** Longest wait between attempts on a renewal that keeps failing. */
export const MAX_BACKOFF_MS = DAY_MS
/** At most this many new certificates per organization per day. */
export const MAX_NEW_PER_DAY = 10

export const clock = (ctx: DnsCertContext): Date => (ctx.now ?? (() => new Date()))()
