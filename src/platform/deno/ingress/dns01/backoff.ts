/**
 * Retry timing inside the authority's limits, and one plain cause per
 * failure. Let's Encrypt allows 5 failed validations per name per account per
 * hour and 5 certificates per exact name set per week; retries back off with
 * full jitter, are capped at about hourly and stay one start under the hourly
 * limit so a manual retry still fits.
 */
import { type AcmeAuthorization, AcmeError } from '../../../../lib/acme/client.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import { utcMoment } from '../../../../lib/plain-time.ts'
import { type Dns01Cause, type Dns01Failure, type Dns01State, withStage } from './state.ts'

export const DNS01_BACKOFF_BASE_MS = 5 * 60_000
export const DNS01_BACKOFF_CAP_MS = 60 * 60_000
export const DNS01_MAX_STARTS_PER_HOUR = 4
/** After this many failed orders the name waits for a person to press Retry. */
export const DNS01_MAX_ATTEMPTS = 6
/**
 * A nameserver lookup that failed on this host (`dns-lookup`) retries after
 * 1, 5, 15 and 60 minutes, then hourly, and never counts toward
 * `DNS01_MAX_ATTEMPTS`: the authority refused nothing. In preflight no order
 * was opened, so that start leaves the hourly budget alone; while waiting for
 * the record an order was already open, so that start stays in `attemptTimes`
 * and counts against the hourly budget.
 */
export const DNS01_LOOKUP_BACKOFF_MS = [1, 5, 15, 60].map((minutes) => minutes * 60_000)
/** A lookup failure alerts only once it has happened this many times in a row. */
export const DNS01_LOOKUP_ALERT_AFTER = 3
/**
 * After this many orders given up before validation in a day, a name opens no
 * new order (only the preflight runs, hourly) until the oldest ages out or a
 * person presses Retry. Each one left a pending authorization at the
 * authority, which limits pending authorizations and new orders per account.
 */
export const DNS01_MAX_ABANDONED_PER_DAY = 10
/** A kept order is reused only while its authorization has at least this long left. */
export const DNS01_RESUME_MARGIN_MS = 2 * 60 * 60_000
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const MAX_DETAIL = 200

/** Starts within the last hour, from the stored start times. */
export function startsInLastHour(times: readonly string[], now: Date): string[] {
  const since = now.getTime() - HOUR_MS
  return times.filter((at) => Date.parse(at) > since)
}

/**
 * Full jitter in `[base, min(cap, base·2^attempts)]`, pushed past the hour
 * window when the hourly start budget is spent.
 */
export function nextAttemptAt(
  now: Date,
  attempts: number,
  random: () => number,
  recentStarts: readonly string[] = []
): Date {
  const ceiling = Math.min(DNS01_BACKOFF_CAP_MS, DNS01_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts))
  const delay = DNS01_BACKOFF_BASE_MS + random() * (ceiling - DNS01_BACKOFF_BASE_MS)
  return pastStartBudget(now.getTime() + delay, now, recentStarts)
}

/** `at`, or just past the hour window when the hourly start budget is spent. */
function pastStartBudget(at: number, now: Date, recentStarts: readonly string[]): Date {
  const window = startsInLastHour(recentStarts, now)
    .map(Date.parse)
    .sort((a, b) => a - b)
  if (window.length < DNS01_MAX_STARTS_PER_HOUR) return new Date(at)
  const oldestInWindow = window[window.length - DNS01_MAX_STARTS_PER_HOUR] ?? now.getTime()
  return new Date(Math.max(at, oldestInWindow + HOUR_MS + 1000))
}

/** Orders given up within the last day, from the stored times. */
export function abandonedInLastDay(times: readonly string[], now: Date): string[] {
  const since = now.getTime() - DAY_MS
  return times.filter((at) => Date.parse(at) > since)
}

/** Whether the name has given up so many orders today that it must not open another. */
export function orderCapReached(state: Dns01State, now: Date): boolean {
  return abandonedInLastDay(state.abandonedTimes, now).length >= DNS01_MAX_ABANDONED_PER_DAY
}

/**
 * The state when the daily order cap holds a start back after a passing
 * preflight: no order, the failure counts untouched, the preflight again in an
 * hour, and a last error (`order-cap`) that says why and how to lift it.
 */
export function cappedState(state: Dns01State, now: Date, attemptTimes: string[]): Dns01State {
  const window = abandonedInLastDay(state.abandonedTimes, now)
    .map(Date.parse)
    .sort((a, b) => a - b)
  const oldest = window[window.length - DNS01_MAX_ABANDONED_PER_DAY] ?? now.getTime()
  const freeAt = utcMoment(new Date(oldest + DAY_MS))
  const detail =
    `${window.length} certificate orders for this name were given up in the last day, ` +
    `so no new order opens before ${freeAt}. Press Retry once the cause is fixed.`
  return withStage(state, 'backoff', {
    order: null,
    attemptTimes,
    abandonedTimes: abandonedInLastDay(state.abandonedTimes, now),
    nextAttemptAt: new Date(now.getTime() + DNS01_BACKOFF_CAP_MS).toISOString(),
    lastError: {
      cause: 'order-cap',
      detail,
      at: now.toISOString(),
    },
  })
}

/**
 * Whether a kept, never answered order can be picked up again: its
 * authorization is still pending with its DNS-01 challenge unanswered, and it
 * lasts long enough for another wait and validation.
 */
export function canResume(authz: AcmeAuthorization, now: Date): boolean {
  if (authz.status !== 'pending') return false
  const challenge = authz.challenges.find((item) => item.type === 'dns-01')
  if (challenge?.status !== 'pending') return false
  const expires = Date.parse(authz.expires ?? '')
  return !Number.isNaN(expires) && expires - now.getTime() > DNS01_RESUME_MARGIN_MS
}

export function isLookupFailure(cause: Dns01Cause): boolean {
  return cause === 'dns-lookup'
}

/** When the `n`th lookup failure in a row (from 1) tries again. */
export function lookupRetryAt(now: Date, n: number, recentStarts: readonly string[] = []): Date {
  const index = Math.min(Math.max(n, 1), DNS01_LOOKUP_BACKOFF_MS.length) - 1
  return pastStartBudget(now.getTime() + DNS01_LOOKUP_BACKOFF_MS[index]!, now, recentStarts)
}

/**
 * The state after a failure. An order failure counts toward
 * `DNS01_MAX_ATTEMPTS` and stops at `failed`; a lookup failure only backs off
 * and keeps the count where it was. `attemptTimes` replaces the stored start
 * times (a start that never reached the authority is dropped from them).
 */
export function failureState(
  state: Dns01State,
  failure: Dns01Failure,
  input: {
    now: Date
    random: () => number
    stopUntil: Date | null
    attemptTimes?: string[]
  }
): Dns01State {
  const { now, stopUntil } = input
  const attemptTimes = input.attemptTimes ?? state.attemptTimes
  const common = {
    order: null,
    attemptTimes,
    stopUntil: stopUntil?.toISOString() ?? state.stopUntil,
    lastError: { ...failure, at: now.toISOString() },
  }
  if (isLookupFailure(failure.cause)) {
    const lookupFailures = state.lookupFailures + 1
    const retry = stopUntil ?? lookupRetryAt(now, lookupFailures, attemptTimes)
    return withStage(state, 'backoff', {
      ...common,
      lookupFailures,
      nextAttemptAt: retry.toISOString(),
    })
  }
  const attempts = state.attempts + 1
  const exhausted = attempts >= DNS01_MAX_ATTEMPTS
  const retry = stopUntil ?? nextAttemptAt(now, attempts, input.random, attemptTimes)
  return withStage(state, exhausted ? 'failed' : 'backoff', {
    ...common,
    attempts,
    lookupFailures: 0,
    nextAttemptAt: exhausted ? null : retry.toISOString(),
  })
}

/** Whether this failure is worth an alert: a lookup blip is not, until it repeats. */
export function alertsFor(state: Dns01State, failure: Dns01Failure): boolean {
  return !isLookupFailure(failure.cause) || state.lookupFailures >= DNS01_LOOKUP_ALERT_AFTER
}

/** The control plane's own account cannot be used (terms not accepted, no contact). */
export class Dns01AccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Dns01AccountError'
  }
}

export type MappedFailure = { cause: Dns01Cause; detail: string; stopUntil: Date | null }

function trimmed(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text
}

function retryAfterFrom(detail: string): Date | null {
  const match = /retry after (\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/i.exec(detail)
  const at = match ? Date.parse(`${match[1]}T${match[2]}Z`) : Number.NaN
  return Number.isNaN(at) ? null : new Date(at)
}

function topOfNextHour(now: Date): Date {
  const next = new Date(now)
  next.setUTCMinutes(0, 0, 0)
  return new Date(next.getTime() + HOUR_MS)
}

function mapRateLimit(err: AcmeError, now: Date): MappedFailure {
  if (/too many certificates/i.test(err.message)) {
    return {
      cause: 'duplicate-limit',
      detail: 'The certificate authority already issued the weekly maximum for this name.',
      stopUntil: retryAfterFrom(err.message) ?? new Date(now.getTime() + WEEK_MS),
    }
  }
  if (/too many failed authorizations/i.test(err.message)) {
    return {
      cause: 'failed-authz-limit',
      detail: 'Too many failed validations for this name in the last hour.',
      stopUntil: retryAfterFrom(err.message) ?? topOfNextHour(now),
    }
  }
  const wait = err.retryAfterMs === null ? null : new Date(now.getTime() + err.retryAfterMs)
  return { cause: 'acme-error', detail: trimmed(err.message), stopUntil: wait }
}

function mapAcme(err: AcmeError, now: Date): MappedFailure {
  if (err.code === 'rate_limited') return mapRateLimit(err, now)
  if (err.code === 'caa') {
    return { cause: 'caa-forbids', detail: trimmed(err.message), stopUntil: null }
  }
  if (err.code === 'dns' || err.code === 'unauthorized') {
    const detail = `The certificate authority could not see the challenge record: ${err.message}`
    return { cause: 'txt-not-visible', detail: trimmed(detail), stopUntil: null }
  }
  if (err.code === 'account_gone') {
    return {
      cause: 'account-error',
      detail: 'The certificate authority account is no longer valid.',
      stopUntil: null,
    }
  }
  return { cause: 'acme-error', detail: trimmed(err.message), stopUntil: null }
}

function mapProvider(err: TunnelProviderError, now: Date): MappedFailure {
  if (err.code === 'unauthorized' || err.code === 'forbidden') {
    return {
      cause: 'scope-missing',
      detail: 'The Cloudflare token cannot edit DNS records for this name.',
      stopUntil: null,
    }
  }
  if (err.code === 'rate_limited') {
    const wait = err.retryAfterMs ?? 60_000
    return {
      cause: 'provider-rate-limited',
      detail: trimmed(err.message),
      stopUntil: new Date(now.getTime() + wait),
    }
  }
  return { cause: 'provider-error', detail: trimmed(err.message), stopUntil: null }
}

/** One plain cause for a thrown failure. Messages are already free of tokens. */
export function mapAcmeFailure(err: unknown, now: Date): MappedFailure {
  if (err instanceof AcmeError) return mapAcme(err, now)
  if (err instanceof TunnelProviderError) return mapProvider(err, now)
  if (err instanceof Dns01AccountError) {
    return { cause: 'account-error', detail: err.message, stopUntil: null }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { cause: 'acme-error', detail: trimmed(message), stopUntil: null }
}
