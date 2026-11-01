/**
 * An in-memory Cloudflare API for the ingress tests: tunnels, DNS records,
 * token verify and zones. Every request is logged by method and path; the
 * Authorization header is checked against the one token it accepts. No
 * network.
 */

export type FakeTunnel = { id: string; name: string; status: string; connections: unknown[] }
export type FakeRecord = {
  id: string
  type: string
  name: string
  content: string
  proxied?: boolean
}

export type FakeCloudflareOptions = {
  token: string
  accountId?: string
  zones?: { id: string; name: string }[]
  /** Paths (regex source) that answer 403, to take a scope away. */
  forbidden?: RegExp[]
  expiresOn?: string
}

export type FakeCloudflare = {
  fetch: typeof fetch
  log: string[]
  tunnels: FakeTunnel[]
  records: Map<string, FakeRecord[]>
  configurations: Map<string, unknown>
}

function envelope(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      success: status < 400,
      errors: status < 400 ? [] : [{ message: 'refused' }],
      result,
    }),
    { status, headers: { 'content-type': 'application/json' } }
  )
}

type Handler = (match: RegExpMatchArray, body: Record<string, unknown>) => Response

export function createFakeCloudflare(options: FakeCloudflareOptions): FakeCloudflare {
  const accountId = options.accountId ?? 'acct-1'
  const zones = options.zones ?? [{ id: 'zone-1', name: 'example.com' }]
  const state: FakeCloudflare = {
    fetch: undefined as unknown as typeof fetch,
    log: [],
    tunnels: [],
    records: new Map(zones.map((zone) => [zone.id, []])),
    configurations: new Map(),
  }
  let counter = 0
  const nextId = (prefix: string) => `${prefix}-${++counter}`
  const zoneRecords = (zoneId: string) => state.records.get(zoneId) ?? []

  const routes: [string, RegExp, Handler][] = [
    [
      'GET',
      /^\/user\/tokens\/verify$/,
      () => envelope({ status: 'active', expires_on: options.expiresOn }),
    ],
    ['GET', /^\/accounts\?page=/, () => envelope([{ id: accountId, name: 'Fixture' }])],
    ['GET', /^\/zones\?account\.id=/, () => envelope(zones)],
    ['GET', /^\/zones\/([^/]+)\/dns_records\?per_page=1/, () => envelope([])],
    [
      'GET',
      /^\/zones\/([^/]+)\/dns_records\?name=([^&]+)/,
      (m) => envelope(zoneRecords(m[1]!).filter((r) => r.name === decodeURIComponent(m[2]!))),
    ],
    [
      'POST',
      /^\/zones\/([^/]+)\/dns_records$/,
      (m, body) => {
        const record = { id: nextId('rec'), ...(body as Omit<FakeRecord, 'id'>) }
        zoneRecords(m[1]!).push(record)
        return envelope(record)
      },
    ],
    [
      'PUT',
      /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/,
      (m, body) => {
        const list = zoneRecords(m[1]!)
        const index = list.findIndex((r) => r.id === m[2])
        list[index] = { id: m[2]!, ...(body as Omit<FakeRecord, 'id'>) }
        return envelope(list[index])
      },
    ],
    [
      'DELETE',
      /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/,
      (m) => {
        state.records.set(
          m[1]!,
          zoneRecords(m[1]!).filter((r) => r.id !== m[2])
        )
        return envelope({ id: m[2] })
      },
    ],
    [
      'GET',
      /^\/accounts\/[^/]+\/cfd_tunnel\?is_deleted=false&per_page=1/,
      () => envelope(state.tunnels.slice(0, 1)),
    ],
    [
      'GET',
      /^\/accounts\/[^/]+\/cfd_tunnel\?is_deleted=false&name=([^&]+)/,
      (m) => envelope(state.tunnels.filter((t) => t.name === decodeURIComponent(m[1]!))),
    ],
    [
      'POST',
      /^\/accounts\/[^/]+\/cfd_tunnel$/,
      (_m, body) => {
        const tunnel = {
          id: nextId('tun'),
          name: String(body.name),
          status: 'inactive',
          connections: [],
        }
        state.tunnels.push(tunnel)
        return envelope(tunnel)
      },
    ],
    [
      'GET',
      /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/token$/,
      (m) => envelope(`run-token-for-${m[1]}`),
    ],
    [
      'PUT',
      /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/configurations$/,
      (m, body) => {
        state.configurations.set(m[1]!, body)
        return envelope({})
      },
    ],
    [
      'GET',
      /^\/accounts\/[^/]+\/cfd_tunnel\/([^/?]+)$/,
      (m) => envelope(state.tunnels.find((t) => t.id === m[1])),
    ],
    [
      'DELETE',
      /^\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)$/,
      (m) => {
        state.tunnels = state.tunnels.filter((t) => t.id !== m[1])
        return envelope({})
      },
    ],
  ]

  const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/client/v4', '') + url.search
    const method = init?.method ?? 'GET'
    state.log.push(`${method} ${path}`)
    const auth = new Headers(init?.headers).get('authorization')
    if (auth !== `Bearer ${options.token}`) return envelope(null, 401)
    if (options.forbidden?.some((pattern) => pattern.test(path))) return envelope(null, 403)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    for (const [verb, pattern, handler] of routes) {
      const match = verb === method ? path.match(pattern) : null
      if (match) return handler(match, body)
    }
    return envelope(null, 404)
  }
  state.fetch = (input, init) => Promise.resolve(respond(input, init))
  return state
}
