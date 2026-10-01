/**
 * Breached-password check against Have I Been Pwned's range API (k-anonymity).
 *
 * Only the first five hex characters of the password's SHA-1 are ever sent
 * (`GET https://api.pwnedpasswords.com/range/<prefix>`, `Add-Padding: true`);
 * the password and the full hash never leave the process, and neither is
 * logged. The response lists every known suffix for that prefix and the match
 * is made here.
 *
 * Fail-open by decision: a self-hosted control plane may be offline, so an
 * unreachable or slow API (2 s budget) allows the password and logs a
 * warning. Tests (and any future offline mirror) replace the network call
 * through the {@link BreachRangeResponder} seam, set on the request context as
 * `breachRangeResponder`.
 *
 * Uses `fetch` and Web Crypto only, so it runs on Deno and Workers alike.
 */
import type { Context } from 'hono'
import { compatLogWarn } from '../../lib/log-compat.ts'

export const BREACH_RANGE_URL = 'https://api.pwnedpasswords.com/range/'
export const BREACH_CHECK_TIMEOUT_MS = 2000
export const BREACH_PREFIX_LENGTH = 5

/** The stable error code every refusing route answers with. */
export const PASSWORD_BREACHED = 'password_breached'
export const PASSWORD_BREACHED_MESSAGE =
  'That password has appeared in a known data breach. Please choose a different one.'

/** Returns the range response body (`SUFFIX:COUNT` lines) for a 5-character hex prefix; rejects when unreachable. */
export type BreachRangeResponder = (prefix: string, signal: AbortSignal) => Promise<string>

declare module 'hono' {
  interface ContextVariableMap {
    /** Test seam: replaces the network lookup; unset in production. */
    breachRangeResponder?: BreachRangeResponder
  }
}

export type BreachResult = 'breached' | 'clean' | 'unavailable'

/** The HIBP range protocol is defined over SHA-1; it is a lookup key here, not a credential hash. */
async function sha1HexUpper(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
}

/** Split a password's SHA-1 into the part that is sent (prefix) and the part that stays here (suffix). */
export async function breachLookupKey(
  password: string
): Promise<{ prefix: string; suffix: string }> {
  const hash = await sha1HexUpper(password)
  return { prefix: hash.slice(0, BREACH_PREFIX_LENGTH), suffix: hash.slice(BREACH_PREFIX_LENGTH) }
}

/** Whether `suffix` appears in a range body with a count above zero (padding rows have count 0). */
export function rangeBodyContains(body: string, suffix: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    if (line.slice(0, colon).trim().toUpperCase() !== suffix) continue
    const count = Number.parseInt(line.slice(colon + 1).trim(), 10)
    return Number.isFinite(count) && count > 0
  }
  return false
}

/** The production responder: HTTPS to the public API with padding on. */
export const fetchBreachRange: BreachRangeResponder = async (prefix, signal) => {
  const res = await fetch(`${BREACH_RANGE_URL}${prefix}`, {
    headers: { 'Add-Padding': 'true' },
    signal,
  })
  if (!res.ok) throw new Error(`range API answered ${res.status}`)
  return await res.text()
}

function describeFailure(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error'
}

export async function checkBreachedPassword(
  password: string,
  responder: BreachRangeResponder = fetchBreachRange
): Promise<BreachResult> {
  const { prefix, suffix } = await breachLookupKey(password)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BREACH_CHECK_TIMEOUT_MS)
  try {
    const body = await responder(prefix, controller.signal)
    return rangeBodyContains(body, suffix) ? 'breached' : 'clean'
  } catch (err) {
    // Never the password, hash or prefix: only the failure kind.
    compatLogWarn(
      'auth',
      `breached-password check skipped (allowed, fail-open): ${describeFailure(err)}`
    )
    return 'unavailable'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The refusal to answer with when `password` is known to be breached, else
 * `null`. Resolves the responder from the request context so tests inject one.
 */
export async function refuseIfBreached(c: Context, password: string): Promise<Response | null> {
  const responder = c.get('breachRangeResponder')
  const result = await checkBreachedPassword(password, responder)
  if (result !== 'breached') return null
  return c.json({ ok: false, error: PASSWORD_BREACHED, message: PASSWORD_BREACHED_MESSAGE }, 400)
}
