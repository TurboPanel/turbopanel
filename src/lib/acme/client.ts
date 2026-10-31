/**
 * A small ACME v2 client (RFC 8555) for DNS-01 orders. `fetch` is injected so
 * tests never reach a real certificate authority, and every call is one plain
 * request, so the work a caller does per step stays bounded. The account key
 * never leaves the object that holds it.
 */
import { base64urlEncode } from '../encoding/base64url.ts'
import { isThrottleStatus, parseRetryAfterMs, throttleWaitMs } from '../http/retry-after.ts'
import { type AcmeAccountKey, dnsChallengeValue, signJws } from './jws.ts'
import { type AcmeSession, sessionFor } from './session.ts'

const REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_RETRY_AFTER_MS = 3_600_000

export type AcmeErrorCode =
  | 'rate_limited'
  | 'already_replaced'
  | 'unauthorized'
  | 'account_gone'
  | 'rejected_name'
  | 'caa'
  | 'dns'
  | 'malformed'
  | 'server'
  | 'unreachable'
  | 'unknown'

/** A refusal or failure from the certificate authority, in words a person can act on. */
export class AcmeError extends Error {
  readonly code: AcmeErrorCode
  /** How long to wait before asking again, when the authority said (429 or 503 with `Retry-After`, or a rate limit). */
  readonly retryAfterMs: number | null
  /** The HTTP status of the answer; null when there was none. */
  readonly status: number | null
  constructor(
    code: AcmeErrorCode,
    message: string,
    retryAfterMs: number | null = null,
    status: number | null = null
  ) {
    super(message)
    this.name = 'AcmeError'
    this.code = code
    this.retryAfterMs = retryAfterMs
    this.status = status
  }
}

type Problem = { type?: string; detail?: string; subproblems?: { detail?: string }[] }

const PROBLEM_CODES: Record<string, AcmeErrorCode> = {
  rateLimited: 'rate_limited',
  alreadyReplaced: 'already_replaced',
  accountDoesNotExist: 'account_gone',
  unauthorized: 'unauthorized',
  rejectedIdentifier: 'rejected_name',
  caa: 'caa',
  dns: 'dns',
  malformed: 'malformed',
  serverInternal: 'server',
}

function problemCode(problem: Problem | null): AcmeErrorCode {
  const suffix = problem?.type?.split(':').pop() ?? ''
  return PROBLEM_CODES[suffix] ?? 'unknown'
}

/**
 * How long a refusal asks callers to wait: the `Retry-After` of a rate limit,
 * 429 or 503 (a rate limit without one waits the default), or null for any
 * other refusal.
 */
function waitAsked(code: AcmeErrorCode, response: Response): number | null {
  const limited = code === 'rate_limited'
  if (!limited && !isThrottleStatus(response.status)) return null
  const asked = parseRetryAfterMs(response.headers.get('retry-after'))
  if (asked !== null) return asked
  return limited ? DEFAULT_RETRY_AFTER_MS : null
}

/** An answer that is not a success on a plain endpoint (the directory, the nonce): 429 and 503 carry their wait. */
function statusError(response: Response): AcmeError {
  const wait = throttleWaitMs(response)
  const limited = response.status === 429
  return new AcmeError(
    limited ? 'rate_limited' : 'server',
    `The certificate authority answered ${response.status}`,
    wait ?? (limited ? DEFAULT_RETRY_AFTER_MS : null),
    response.status
  )
}

export type AcmeDirectory = {
  newNonce: string
  newAccount: string
  newOrder: string
  /** ACME Renewal Information (RFC 9773); absent on an authority without it. */
  renewalInfo?: string
}

export type AcmeIdentifier = { type: 'dns'; value: string }
export type AcmeOrderStatus = 'pending' | 'ready' | 'processing' | 'valid' | 'invalid'
export type AcmeOrder = {
  url: string
  status: AcmeOrderStatus
  identifiers: AcmeIdentifier[]
  authorizations: string[]
  finalize: string
  certificate?: string
  error?: Problem
}
export type AcmeChallenge = {
  type: string
  url: string
  token: string
  status: string
  error?: Problem
}
export type AcmeAuthorization = {
  url: string
  status: 'pending' | 'valid' | 'invalid' | 'deactivated' | 'expired' | 'revoked'
  identifier: AcmeIdentifier
  wildcard: boolean
  challenges: AcmeChallenge[]
}

export type AcmeClientOptions = {
  directoryUrl: string
  key: AcmeAccountKey
  /** Set once the account exists; found again with {@link AcmeClient.ensureAccount} otherwise. */
  accountUrl?: string | null
  fetch?: typeof fetch
}

/** A plain function so the Workers runtime accepts the global `fetch`. */
const networkFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)

async function sendTimed(send: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await send(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'request failed'
    throw new AcmeError('unreachable', `The certificate authority could not be reached: ${reason}`)
  }
}

/** The authority's directory, from the session's cache while it is fresh. */
async function loadDirectory(
  directoryUrl: string,
  send: typeof fetch,
  session: AcmeSession
): Promise<AcmeDirectory> {
  const cached = session.directory(directoryUrl)
  if (cached) return cached
  const response = await sendTimed(send, directoryUrl, { method: 'GET' })
  if (!response.ok) throw statusError(response)
  const body = (await response.json()) as Partial<AcmeDirectory>
  if (!body.newNonce || !body.newAccount || !body.newOrder) {
    throw new AcmeError('server', 'The certificate authority sent an incomplete directory')
  }
  const directory: AcmeDirectory = {
    newNonce: body.newNonce,
    newAccount: body.newAccount,
    newOrder: body.newOrder,
    ...(body.renewalInfo ? { renewalInfo: body.renewalInfo } : {}),
  }
  session.rememberDirectory(directoryUrl, directory)
  return directory
}

export class AcmeClient {
  readonly #directoryUrl: string
  readonly #key: AcmeAccountKey
  readonly #fetch: typeof fetch
  readonly #session: AcmeSession
  #accountUrl: string | null

  constructor(options: AcmeClientOptions) {
    this.#directoryUrl = options.directoryUrl
    this.#key = options.key
    this.#accountUrl = options.accountUrl ?? null
    this.#fetch = options.fetch ?? networkFetch
    this.#session = sessionFor(options.fetch)
  }

  get accountUrl(): string | null {
    return this.#accountUrl
  }

  #request(url: string, init: RequestInit): Promise<Response> {
    return sendTimed(this.#fetch, url, init)
  }

  #loadDirectory(): Promise<AcmeDirectory> {
    return loadDirectory(this.#directoryUrl, this.#fetch, this.#session)
  }

  /** A spare nonce from an earlier answer, or a fresh one from the authority. */
  async #takeNonce(): Promise<string> {
    const spare = this.#session.takeNonce(this.#directoryUrl)
    if (spare) return spare
    const directory = await this.#loadDirectory()
    const response = await this.#request(directory.newNonce, { method: 'HEAD' })
    if (!response.ok) throw statusError(response)
    const nonce = response.headers.get('replay-nonce')
    if (!nonce) throw new AcmeError('server', 'The certificate authority sent no nonce')
    return nonce
  }

  async #postOnce(url: string, payload: unknown, withKid: boolean): Promise<Response> {
    const nonce = await this.#takeNonce()
    const body = await signJws(this.#key, {
      url,
      nonce,
      payload,
      ...(withKid && this.#accountUrl ? { kid: this.#accountUrl } : {}),
    })
    const response = await this.#request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json', Accept: 'application/json' },
      body,
    })
    // Every answer carries the next nonce, errors included.
    this.#session.rememberNonce(this.#directoryUrl, response.headers.get('replay-nonce'))
    return response
  }

  async #failure(response: Response): Promise<AcmeError> {
    let problem: Problem | null = null
    try {
      problem = (await response.json()) as Problem
    } catch {
      problem = null
    }
    const raw = response.status === 429 ? 'rate_limited' : problemCode(problem)
    // An account the authority has switched off is refused as unauthorized.
    const code =
      raw === 'unauthorized' && /deactivat|not valid|revoked/i.test(problem?.detail ?? '')
        ? 'account_gone'
        : raw
    const detail = problem?.detail ?? `The certificate authority answered ${response.status}`
    const sub = problem?.subproblems?.find((p) => p.detail)?.detail
    const wait = waitAsked(code, response)
    return new AcmeError(code, sub ? `${detail} (${sub})` : detail, wait, response.status)
  }

  /** POST a signed request; a stale nonce is replaced and tried once more. */
  async #post(url: string, payload: unknown, withKid = true): Promise<Response> {
    let response = await this.#postOnce(url, payload, withKid)
    if (response.status === 400) {
      const retry = response.clone()
      const problem = (await retry.json().catch(() => null)) as Problem | null
      if (problem?.type?.endsWith(':badNonce'))
        response = await this.#postOnce(url, payload, withKid)
    }
    if (!response.ok) throw await this.#failure(response)
    return response
  }

  /** Create the account, or find the one this key already has. */
  async ensureAccount(contact?: readonly string[]): Promise<string> {
    if (this.#accountUrl) return this.#accountUrl
    const directory = await this.#loadDirectory()
    const response = await this.#post(
      directory.newAccount,
      {
        termsOfServiceAgreed: true,
        ...(contact && contact.length > 0 ? { contact } : {}),
      },
      false
    )
    const location = response.headers.get('location')
    if (!location)
      throw new AcmeError('server', 'The certificate authority sent no account address')
    this.#accountUrl = location
    return location
  }

  /**
   * Open an order. `replaces` is the renewal-information identifier of the
   * certificate this one renews (RFC 9773): the authority then treats the
   * order as a renewal. It is only sent to an authority that offers renewal
   * information.
   */
  async newOrder(
    names: readonly string[],
    options: { replaces?: string } = {}
  ): Promise<AcmeOrder> {
    const directory = await this.#loadDirectory()
    const identifiers = names.map((value) => ({ type: 'dns' as const, value }))
    const replaces = directory.renewalInfo ? options.replaces : undefined
    const response = await this.#post(directory.newOrder, {
      identifiers,
      ...(replaces ? { replaces } : {}),
    })
    const order = (await response.json()) as Omit<AcmeOrder, 'url'>
    const url = response.headers.get('location')
    if (!url) throw new AcmeError('server', 'The certificate authority sent no order address')
    return { ...order, url }
  }

  async getOrder(url: string): Promise<AcmeOrder> {
    const response = await this.#post(url, '')
    return { ...((await response.json()) as Omit<AcmeOrder, 'url'>), url }
  }

  async getAuthorization(url: string): Promise<AcmeAuthorization> {
    const response = await this.#post(url, '')
    return { ...((await response.json()) as Omit<AcmeAuthorization, 'url'>), url }
  }

  /** The TXT value that answers the DNS-01 challenge with this `token`. */
  dnsValue(token: string): Promise<string> {
    return dnsChallengeValue(this.#key, token)
  }

  /** Tell the authority the TXT record is in place. */
  async answerChallenge(url: string): Promise<void> {
    await this.#post(url, {})
  }

  /** Send the request for the certificate; the order's own address stays the caller's. */
  async finalize(url: string, csr: Uint8Array): Promise<Omit<AcmeOrder, 'url'>> {
    const response = await this.#post(url, { csr: base64urlEncode(csr) })
    return (await response.json()) as Omit<AcmeOrder, 'url'>
  }

  /** The certificate chain PEM of a valid order. */
  async downloadCertificate(url: string): Promise<string> {
    const response = await this.#post(url, '')
    return await response.text()
  }
}

export type RenewalWindow = { start: Date; end: Date }

/** What asking the authority about a certificate's renewal time came to (RFC 9773). */
export type RenewalInfo = {
  /** The suggested window; null when the authority gave none. */
  window: RenewalWindow | null
  /**
   * True when the authority answered (even "no such service" or "unknown
   * certificate"), false when asking failed (unreachable, 429, 503, junk), so
   * a caller keeps the time it already has instead of falling back.
   */
  answered: boolean
  /** The `Retry-After` of the answer: how long the authority wants callers to wait before asking again. */
  retryAfterMs: number | null
  /** The HTTP status of the renewal-information answer; null when there was none. */
  status: number | null
}

const NO_ANSWER: RenewalInfo = { window: null, answered: false, retryAfterMs: null, status: null }

function readWindow(body: { suggestedWindow?: { start?: string; end?: string } }) {
  const start = Date.parse(body.suggestedWindow?.start ?? '')
  const end = Date.parse(body.suggestedWindow?.end ?? '')
  return Number.isNaN(start) || Number.isNaN(end) || end < start
    ? null
    : { start: new Date(start), end: new Date(end) }
}

/**
 * Ask the authority when to renew a certificate (RFC 9773) and how soon to ask
 * again. Never throws: the caller has its own fallback. `certId` comes from
 * `renewalCertId`.
 */
export async function fetchRenewalInfo(options: {
  directoryUrl: string
  certId: string
  fetch?: typeof fetch
}): Promise<RenewalInfo> {
  const send = options.fetch ?? networkFetch
  try {
    const directory = await loadDirectory(options.directoryUrl, send, sessionFor(options.fetch))
    // An authority without the service will not start offering it today.
    if (!directory.renewalInfo)
      return { window: null, answered: true, retryAfterMs: null, status: null }
    const response = await send(`${directory.renewalInfo.replace(/\/$/, '')}/${options.certId}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
    if (!response.ok) {
      // A certificate the authority does not know is an answer; a throttle or an outage is not.
      const answered = response.status === 404
      return { window: null, answered, retryAfterMs, status: response.status }
    }
    const window = readWindow((await response.json()) as Parameters<typeof readWindow>[0])
    return { window, answered: window !== null, retryAfterMs, status: response.status }
  } catch (err) {
    if (err instanceof AcmeError) {
      return { ...NO_ANSWER, retryAfterMs: err.retryAfterMs, status: err.status }
    }
    return NO_ANSWER
  }
}

/** The suggested renewal window of a certificate, or null; see {@link fetchRenewalInfo}. */
export async function fetchRenewalWindow(options: {
  directoryUrl: string
  certId: string
  fetch?: typeof fetch
}): Promise<RenewalWindow | null> {
  return (await fetchRenewalInfo(options)).window
}
