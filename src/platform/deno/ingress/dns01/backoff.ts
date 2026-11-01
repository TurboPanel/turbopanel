/**
 * Retry timing inside the authority's limits, and one plain cause per
 * failure. Let's Encrypt allows 5 failed validations per name per account per
 * hour and 5 certificates per exact name set per week; retries back off with
 * full jitter, are capped at about hourly and stay one start under the hourly
 * limit so a manual retry still fits.
 */
import { AcmeError } from '../../../../lib/acme/client.ts'
import { TunnelProviderError } from '../../../../features/tunnels/errors.ts'
import type { Dns01Cause } from './state.ts'

export const DNS01_BACKOFF_BASE_MS = 5 * 60_000
export const DNS01_BACKOFF_CAP_MS = 60 * 60_000
export const DNS01_MAX_STARTS_PER_HOUR = 4
/** After this many failed orders the name waits for a person to press Retry. */
export const DNS01_MAX_ATTEMPTS = 6
const HOUR_MS = 60 * 60_000
const WEEK_MS = 7 * 24 * HOUR_MS
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
  const at = now.getTime() + delay
  const window = startsInLastHour(recentStarts, now)
    .map(Date.parse)
    .sort((a, b) => a - b)
  if (window.length < DNS01_MAX_STARTS_PER_HOUR) return new Date(at)
  const oldestInWindow = window[window.length - DNS01_MAX_STARTS_PER_HOUR] ?? now.getTime()
  return new Date(Math.max(at, oldestInWindow + HOUR_MS + 1000))
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
  const next = new Date(now.getTime())
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
