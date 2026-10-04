/**
 * The runner's only door to the panel. Safety is enforced here, not in the
 * checks: every request goes to the allowlisted origin, redirects to another
 * host are refused, and a read-only client refuses every verb but GET.
 */
import { SafetyError, assertTargetUrl, isRecord } from './safety.ts'
import type { Api, ApiRequestInit, ApiResponse, Json } from './types.ts'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface ApiClientOptions {
  origin: string
  fetch: FetchLike
  /** Refuse every verb but GET (sign-in and reauth are internal and exempt). */
  readOnly: boolean
  sleep: (ms: number) => Promise<void>
}

export interface Credentials {
  email: string
  password: string
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const SIGN_IN_PATH = '/client/v1/auth/sign-in'
const REAUTH_PATH = '/client/v1/auth/reauth'
const TRANSIENT_DNS = /dns|lookup|EAI_AGAIN|ENOTFOUND|getaddrinfo|temporary failure/i

export class ApiClient implements Api {
  readonly #origin: string
  readonly #fetch: FetchLike
  readonly #readOnly: boolean
  readonly #sleep: (ms: number) => Promise<void>
  readonly #cookies = new Map<string, string>()
  #credentials: Credentials | undefined
  #orgId = ''

  constructor(options: ApiClientOptions) {
    this.#origin = assertTargetUrl(options.origin)
    this.#fetch = options.fetch
    this.#readOnly = options.readOnly
    this.#sleep = options.sleep
  }

  get orgId(): string {
    return this.#orgId
  }

  get readOnly(): boolean {
    return this.#readOnly
  }

  /**
   * Sign in and pick the organization (`organizationId`, or the first one
   * listed; none for a brand-new user). Throws unless the panel answers 200.
   */
  async signIn(credentials: Credentials, organizationId?: string): Promise<void> {
    const status = await this.trySignIn(credentials)
    if (status !== 200) throw new Error(`sign-in failed: HTTP ${status}`)
    this.#orgId = organizationId ?? (await this.#firstOrganization())
  }

  /** Attempt a sign-in and return the HTTP status (for negative checks). */
  async trySignIn(credentials: Credentials): Promise<number> {
    this.#credentials = credentials
    const res = await this.#send('POST', SIGN_IN_PATH, {
      email: credentials.email,
      password: credentials.password,
    })
    return res.status
  }

  /** A second client on the same origin and safety mode, with its own cookie jar. */
  fork(): ApiClient {
    return new ApiClient({
      origin: this.#origin,
      fetch: this.#fetch,
      readOnly: this.#readOnly,
      sleep: this.#sleep,
    })
  }

  get(path: string): Promise<ApiResponse> {
    return this.#request('GET', path, {})
  }
  post(path: string, init: ApiRequestInit = {}): Promise<ApiResponse> {
    return this.#request('POST', path, init)
  }
  put(path: string, init: ApiRequestInit = {}): Promise<ApiResponse> {
    return this.#request('PUT', path, init)
  }
  patch(path: string, init: ApiRequestInit = {}): Promise<ApiResponse> {
    return this.#request('PATCH', path, init)
  }
  del(path: string, init: ApiRequestInit = { reauth: true }): Promise<ApiResponse> {
    return this.#request('DELETE', path, init)
  }

  async #firstOrganization(): Promise<string> {
    const res = await this.#send('GET', '/client/v1/organizations')
    const list = organizationsOf(res.body)
    const id = list[0]?.id
    return typeof id === 'string' ? id : ''
  }

  async #request(method: Method, path: string, init: ApiRequestInit): Promise<ApiResponse> {
    if (this.#readOnly && method !== 'GET') {
      throw new SafetyError(`read-only run: ${method} ${path} refused`)
    }
    const res = await this.#send(method, this.#scoped(path), init.body)
    if (!init.reauth || !needsReauth(res)) return res
    await this.#reauth()
    return this.#send(method, this.#scoped(path), init.body)
  }

  async #reauth(): Promise<void> {
    if (!this.#credentials) throw new Error('reauth requested before sign-in')
    const res = await this.#send('POST', REAUTH_PATH, { password: this.#credentials.password })
    if (res.status >= 300) throw new Error(`reauth failed: HTTP ${res.status}`)
  }

  #scoped(path: string): string {
    if (!this.#orgId) return path
    const sep = path.includes('?') ? '&' : '?'
    return `${path}${sep}organizationId=${encodeURIComponent(this.#orgId)}`
  }

  async #send(method: Method, path: string, body?: Json): Promise<ApiResponse> {
    const url = `${this.#origin}/api${path}`
    const init: RequestInit = { method, headers: this.#headers(body), redirect: 'manual' }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await this.#fetchWithDnsRetry(url, init)
    this.#guardRedirect(response)
    this.#storeCookies(response.headers)
    return { status: response.status, body: await readJson(response), headers: response.headers }
  }

  #headers(body?: Json): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.#orgId) headers['x-turbopanel-organization-id'] = this.#orgId
    const cookie = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    if (cookie) headers.cookie = cookie
    return headers
  }

  async #fetchWithDnsRetry(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init)
    } catch (error) {
      if (!TRANSIENT_DNS.test(String(error))) throw error
      await this.#sleep(2000)
      return this.#fetch(url, init)
    }
  }

  #guardRedirect(response: Response): void {
    if (response.status < 300 || response.status >= 400) return
    const location = response.headers.get('location')
    if (!location) return
    const target = new URL(location, this.#origin)
    if (target.origin !== this.#origin) {
      throw new SafetyError(`redirect to ${target.origin} refused`)
    }
  }

  #storeCookies(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair] = line.split(';')
      const eq = pair?.indexOf('=') ?? -1
      if (!pair || eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' || /max-age=0/i.test(line)) this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
  }
}

async function readJson(response: Response): Promise<Json> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as Json
  } catch {
    return text.slice(0, 500)
  }
}

function organizationsOf(body: Json): { [key: string]: Json }[] {
  const raw = isRecord(body) ? (body.organizations ?? body.data ?? body.items) : body
  return Array.isArray(raw) ? raw.filter(isRecord) : []
}

/** The panel answers a stale session on sensitive routes with a reauth error. */
export function needsReauth(res: ApiResponse): boolean {
  if (res.status !== 401 && res.status !== 403) return false
  return /reauth|recent/i.test(JSON.stringify(res.body ?? ''))
}
