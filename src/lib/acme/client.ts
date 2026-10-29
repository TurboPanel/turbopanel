/**
 * A small ACME v2 client (RFC 8555) for DNS-01 orders. `fetch` is injected so
 * tests never reach a real certificate authority, and every call is one plain
 * request, so the work a caller does per step stays bounded. The account key
 * never leaves the object that holds it.
 */
import { base64urlEncode } from '../encoding/base64url.ts'
import { type AcmeAccountKey, dnsChallengeValue, signJws } from './jws.ts'

const REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_RETRY_AFTER_MS = 3_600_000

export type AcmeErrorCode =
  | 'rate_limited'
  | 'unauthorized'
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
  /** How long to wait before asking again, when the authority said. */
  readonly retryAfterMs: number | null
  constructor(code: AcmeErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'AcmeError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

type Problem = { type?: string; detail?: string; subproblems?: { detail?: string }[] }

const PROBLEM_CODES: Record<string, AcmeErrorCode> = {
  rateLimited: 'rate_limited',
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

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 86_400_000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.min(Math.max(at - Date.now(), 0), 86_400_000)
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

export class AcmeClient {
  readonly #directoryUrl: string
  readonly #key: AcmeAccountKey
  readonly #fetch: typeof fetch
  #directory: AcmeDirectory | null = null
  #nonce: string | null = null
  #accountUrl: string | null

  constructor(options: AcmeClientOptions) {
    this.#directoryUrl = options.directoryUrl
    this.#key = options.key
    this.#accountUrl = options.accountUrl ?? null
    // Called as a plain function so the Workers runtime accepts it.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  get accountUrl(): string | null {
    return this.#accountUrl
  }

  async #request(url: string, init: RequestInit): Promise<Response> {
    try {
      const send = this.#fetch
      return await send(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'request failed'
      throw new AcmeError(
        'unreachable',
        `The certificate authority could not be reached: ${reason}`
      )
    }
  }

  async #loadDirectory(): Promise<AcmeDirectory> {
    if (this.#directory) return this.#directory
    const response = await this.#request(this.#directoryUrl, { method: 'GET' })
    if (!response.ok) {
      throw new AcmeError('server', `The certificate authority answered ${response.status}`)
    }
    const body = (await response.json()) as Partial<AcmeDirectory>
    if (!body.newNonce || !body.newAccount || !body.newOrder) {
      throw new AcmeError('server', 'The certificate authority sent an incomplete directory')
    }
    this.#directory = {
      newNonce: body.newNonce,
      newAccount: body.newAccount,
      newOrder: body.newOrder,
      ...(body.renewalInfo ? { renewalInfo: body.renewalInfo } : {}),
    }
    return this.#directory
  }

  async #takeNonce(): Promise<string> {
    if (this.#nonce) {
      const nonce = this.#nonce
      this.#nonce = null
      return nonce
    }
    const directory = await this.#loadDirectory()
    const response = await this.#request(directory.newNonce, { method: 'HEAD' })
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
    this.#nonce = response.headers.get('replay-nonce')
    return response
  }

  async #failure(response: Response): Promise<AcmeError> {
    let problem: Problem | null = null
    try {
      problem = (await response.json()) as Problem
    } catch {
      problem = null
    }
    const code = problemCode(problem)
    const detail = problem?.detail ?? `The certificate authority answered ${response.status}`
    const sub = problem?.subproblems?.find((p) => p.detail)?.detail
    const wait = code === 'rate_limited' ? (retryAfterMs(response) ?? DEFAULT_RETRY_AFTER_MS) : null
    return new AcmeError(code, sub ? `${detail} (${sub})` : detail, wait)
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

  async newOrder(names: readonly string[]): Promise<AcmeOrder> {
    const directory = await this.#loadDirectory()
    const identifiers = names.map((value) => ({ type: 'dns' as const, value }))
    const response = await this.#post(directory.newOrder, { identifiers })
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

/**
 * When the authority suggests renewing a certificate (RFC 9773), or null when
 * it has no such service or does not know the certificate. Never throws: the
 * caller has its own fallback. `certId` comes from {@link renewalCertId}.
 */
export async function fetchRenewalWindow(options: {
  directoryUrl: string
  certId: string
  fetch?: typeof fetch
}): Promise<RenewalWindow | null> {
  const send = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  try {
    const directory = await send(options.directoryUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const base = ((await directory.json()) as Partial<AcmeDirectory>).renewalInfo
    if (!base) return null
    const response = await send(`${base.replace(/\/$/, '')}/${options.certId}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { suggestedWindow?: { start?: string; end?: string } }
    const start = Date.parse(body.suggestedWindow?.start ?? '')
    const end = Date.parse(body.suggestedWindow?.end ?? '')
    return Number.isNaN(start) || Number.isNaN(end) || end < start
      ? null
      : { start: new Date(start), end: new Date(end) }
  } catch {
    return null
  }
}
