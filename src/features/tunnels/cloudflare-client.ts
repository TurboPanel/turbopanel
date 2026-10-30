/**
 * A small typed client for the parts of the Cloudflare API the tunnels feature
 * uses. `fetch` is injected so tests never reach the real service. The token
 * is sent only in the Authorization header; every error message is scrubbed
 * of it before it leaves this file.
 */
import { throttleWaitMs } from '../../lib/http/retry-after.ts'
import { codeForRefusal, TunnelProviderError } from './errors.ts'

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 15_000
const PAGE_SIZE = 50
const MAX_PAGES = 10

type Envelope<T> = {
  success?: boolean
  errors?: { code?: number; message?: string }[]
  result?: T
  result_info?: { total_pages?: number }
}

export type CloudflareAccount = { id: string; name: string }
export type CloudflareZone = { id: string; name: string; account?: { id?: string } }
export type CloudflareTunnel = { id: string; name: string; token?: string }
export type CloudflareIngressRule = {
  hostname?: string
  service: string
  originRequest?: Record<string, unknown>
}
export type CloudflareTokenVerify = { id?: string; status?: string; expires_on?: string }
export type CloudflareDnsRecord = { id: string; name?: string }
export type CloudflareOriginCertificate = {
  id: string
  certificate?: string
  hostnames?: string[]
  expires_on?: string
}

export type CloudflareClientOptions = {
  token: string
  fetch?: typeof fetch
  baseUrl?: string
}

export class CloudflareClient {
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #base: string

  constructor(options: CloudflareClientOptions) {
    this.#token = options.token
    // The platform fetch must be called as a plain function: stored on this object and
    // called as a method it gets the wrong receiver and Workers throws "Illegal invocation".
    // Looked up at call time so a stubbed global fetch is honoured.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#base = options.baseUrl ?? CLOUDFLARE_API_BASE
  }

  async #send(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ result: unknown; totalPages: number }> {
    let response: Response
    try {
      const send = this.#fetch
      response = await send(`${this.#base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'request failed'
      throw new TunnelProviderError(
        'unreachable',
        `Cloudflare could not be reached: ${reason}`,
        null,
        [this.#token]
      )
    }
    let envelope: Envelope<unknown> | null = null
    try {
      envelope = (await response.json()) as Envelope<unknown>
    } catch {
      envelope = null
    }
    if (!response.ok || envelope?.success === false) {
      const detail = (envelope?.errors ?? [])
        .map((e) => e.message)
        .filter((m): m is string => typeof m === 'string' && m.length > 0)
        .join('; ')
      const suffix = detail ? `: ${detail}` : ''
      throw new TunnelProviderError(
        codeForRefusal(response.status, detail),
        `Cloudflare refused the request (${response.status})${suffix}`,
        response.status,
        [this.#token],
        throttleWaitMs(response)
      )
    }
    return { result: envelope?.result ?? null, totalPages: envelope?.result_info?.total_pages ?? 1 }
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#send(method, path, body)).result as T
  }

  /** Read every page of a list endpoint, up to a fixed cap. */
  async #list<T>(path: string): Promise<T[]> {
    const joiner = path.includes('?') ? '&' : '?'
    const items: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { result, totalPages } = await this.#send(
        'GET',
        `${path}${joiner}page=${page}&per_page=${PAGE_SIZE}`
      )
      if (Array.isArray(result)) items.push(...(result as T[]))
      if (page >= totalPages) break
    }
    return items
  }

  listAccounts(): Promise<CloudflareAccount[]> {
    return this.#list<CloudflareAccount>('/accounts')
  }

  /** Zones the token can see, limited to one account when given. */
  listZones(accountId?: string | null): Promise<CloudflareZone[]> {
    return this.#list<CloudflareZone>(
      accountId ? `/zones?account.id=${encodeURIComponent(accountId)}` : '/zones'
    )
  }

  /** One zone by id: its name and account. Needs Zone · Zone · Read, which a narrow token may lack. */
  getZone(zoneId: string): Promise<CloudflareZone> {
    return this.#call('GET', `/zones/${encodeURIComponent(zoneId)}`)
  }

  /** Verify a user-owned token (GET /user/tokens/verify). */
  verifyUserToken(): Promise<CloudflareTokenVerify> {
    return this.#call('GET', '/user/tokens/verify')
  }

  /** Verify an account-owned token (GET /accounts/{account_id}/tokens/verify). */
  verifyAccountToken(accountId: string): Promise<CloudflareTokenVerify> {
    return this.#call('GET', `/accounts/${encodeURIComponent(accountId)}/tokens/verify`)
  }

  /** One-row read: proves the token can read tunnels of the account. */
  async probeTunnels(accountId: string): Promise<void> {
    await this.#call(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?is_deleted=false&per_page=1`
    )
  }

  /** One-row read: proves the token can read DNS records of the zone. */
  async probeDns(zoneId: string): Promise<void> {
    await this.#call('GET', `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=1`)
  }

  /** One-row read: proves the token can read origin certificates of the zone. */
  async probeCertificates(zoneId: string): Promise<void> {
    await this.#call('GET', `/certificates?zone_id=${encodeURIComponent(zoneId)}`)
  }

  /** Ask for an origin certificate for `hostnames`, signed from the caller's own request. */
  createOriginCertificate(input: {
    hostnames: readonly string[]
    csr: string
    validityDays: number
  }): Promise<CloudflareOriginCertificate> {
    return this.#call('POST', '/certificates', {
      hostnames: input.hostnames,
      requested_validity: input.validityDays,
      request_type: 'origin-ecc',
      csr: input.csr,
    })
  }

  /**
   * The origin certificates of a zone that are still valid; revoked ones are not
   * listed. Each item carries the certificate and its names, never a private key
   * (the person who made the request keeps that).
   */
  async listOriginCertificates(zoneId: string): Promise<CloudflareOriginCertificate[]> {
    const list = await this.#call<CloudflareOriginCertificate[] | null>(
      'GET',
      `/certificates?zone_id=${encodeURIComponent(zoneId)}&limit=100`
    )
    return Array.isArray(list) ? list : []
  }

  /**
   * Revoke an origin certificate; it stops being valid at once. Cloudflare
   * answers 400 (not 404) for a certificate that is already revoked ("Certificate
   * already revoked") or that it does not know ("Failed to read certificate"),
   * so those are reported as `not_found`, which callers treat as already gone.
   */
  async revokeOriginCertificate(certificateId: string): Promise<void> {
    try {
      await this.#call('DELETE', `/certificates/${encodeURIComponent(certificateId)}`)
    } catch (err) {
      if (
        err instanceof TunnelProviderError &&
        err.status === 400 &&
        /already revoked|failed to read certificate/i.test(err.message)
      ) {
        throw new TunnelProviderError('not_found', err.message, err.status)
      }
      throw err
    }
  }

  createTunnel(accountId: string, name: string): Promise<CloudflareTunnel> {
    return this.#call('POST', `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, {
      name,
      config_src: 'cloudflare',
    })
  }

  getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return this.#call(
      'GET',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`
    )
  }

  /** Replace the tunnel's ingress rules. The last rule must be a catch-all with no hostname. */
  async putConfiguration(
    accountId: string,
    tunnelId: string,
    ingress: readonly CloudflareIngressRule[]
  ): Promise<void> {
    await this.#call(
      'PUT',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
      { config: { ingress } }
    )
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    await this.#call(
      'DELETE',
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`
    )
  }

  createDnsRecord(
    zoneId: string,
    record: { name: string; content: string }
  ): Promise<CloudflareDnsRecord> {
    return this.#call('POST', `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      type: 'CNAME',
      name: record.name,
      content: record.content,
      proxied: true,
      ttl: 1,
    })
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.#call(
      'DELETE',
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`
    )
  }
}
