/**
 * An in-memory certificate authority for tests: it checks every signed request
 * the way a real one does (nonce, address, signature), validates DNS-01
 * challenges against a TXT lookup the test supplies, checks the request for the
 * certificate (names and signature) and hands back a certificate for exactly
 * those names. No network.
 */
import { children, content, readNode } from '../tls/asn1.ts'
import { mintSelfSignedCertificate } from '../tls/self-signed.ts'
import { base64urlDecode, base64urlEncode } from '../encoding/base64url.ts'
import { accountThumbprint, type AcmeAccountKey } from './jws.ts'

export const FAKE_CA_DIRECTORY = 'https://ca.test/directory'
const BASE = 'https://ca.test'

type Jwk = { crv: string; kty: string; x: string; y: string }
type Authz = {
  id: string
  identifier: string
  wildcard: boolean
  token: string
  answered: boolean
}
type Order = { id: string; names: string[]; authz: Authz[]; finalized: boolean; polls: number }

export type FakeCaOptions = {
  /** The TXT values published at a record name. */
  txt: (name: string) => string[]
  /** Refuse new orders with a rate-limit error. */
  rateLimitOrders?: boolean
  /** Refuse new orders with this plain status (for example 503) and an optional `Retry-After`. */
  busyOrders?: { status: number; retryAfter?: string }
  /** Answer the first nonce-bearing request with a stale-nonce error. */
  staleNonceOnce?: boolean
  /** The order stays `processing` for this many polls after the request. */
  processingPolls?: number
  /** Makes the certificate for an order; the default is a self-signed one. */
  issueCertificate?: (names: string[]) => Promise<string>
  /** Every account refuses its requests as deactivated. */
  alwaysDeactivated?: boolean
  /** Offers renewal information; the window is what it suggests for any certificate. */
  renewalWindow?: { start: Date; end: Date }
  /** `Retry-After` sent with each renewal-information answer. */
  renewalRetryAfter?: string
  /** Renewal information answers 503 (with `renewalRetryAfter` if set) instead of a window. */
  renewalBusy?: boolean
}

export type FakeCa = {
  fetch: typeof fetch
  accounts: Map<string, Jwk>
  orders: Order[]
  /** Every signed request: path and the account address it used, if any. */
  log: { path: string; kid: string | null }[]
  /** The names on each certificate issued, in order. */
  issued: string[][]
  /** Renewal-information requests received (the identifier of each). */
  renewalAsked: string[]
  /** How many times each kind of request reached the authority. */
  hits: { directory: number; nonce: number; renewal: number; signed: number }
  /** From now on every request signed by an account that exists is refused as deactivated. */
  deactivateAccounts: () => void
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
}

function problem(
  type: string,
  detail: string,
  status: number,
  headers: Record<string, string> = {}
) {
  return json({ type: `urn:ietf:params:acme:error:${type}`, detail }, { status, headers })
}

function derSignatureToRaw(der: Uint8Array): Uint8Array {
  const [r, s] = children(readNode(der))
  const fix = (n: typeof r) => {
    const bytes = content(n!)
    const trimmed = bytes[0] === 0 ? bytes.slice(1) : bytes
    const out = new Uint8Array(32)
    out.set(trimmed, 32 - trimmed.length)
    return out
  }
  return Uint8Array.from([...fix(r), ...fix(s)])
}

async function verifyCsr(csr: Uint8Array): Promise<string[]> {
  const root = readNode(csr)
  const [info, , sigBits] = children(root)
  const raw = (node: typeof info) =>
    node!.bytes.subarray(node!.contentOffset - node!.headerLength, node!.end)
  const [, , spki, attrs] = children(info!)
  const key = await crypto.subtle.importKey(
    'spki',
    raw(spki) as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  const signature = derSignatureToRaw(content(sigBits!).subarray(1))
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature as BufferSource,
    raw(info) as BufferSource
  )
  if (!ok) throw new Error('the request signature is wrong')
  // attributes > attribute > set > extensions > extension > octet string > general names
  const attribute = children(attrs!)[0]!
  const extensions = children(children(attribute)[1]!)[0]!
  const san = children(children(extensions)[0]!)[1]!
  const names = children(readNode(content(san)))
  return names.map((n) => new TextDecoder().decode(content(n)))
}

export function createFakeCa(options: FakeCaOptions): FakeCa {
  const accounts = new Map<string, Jwk>()
  const orders: Order[] = []
  const log: FakeCa['log'] = []
  const issued: string[][] = []
  const renewalAsked: string[] = []
  const hits = { directory: 0, nonce: 0, renewal: 0, signed: 0 }
  const deactivated = new Set<string>()
  const nonces = new Set<string>()
  let stale = options.staleNonceOnce === true
  let counter = 0
  const next = (prefix: string) => {
    counter += 1
    return `${prefix}${counter}`
  }

  const freshNonce = () => {
    const nonce = base64urlEncode(crypto.getRandomValues(new Uint8Array(12)))
    nonces.add(nonce)
    return nonce
  }

  type Signed = { kid: string | null; jwk: Jwk; payload: unknown }
  async function open(url: string, body: string): Promise<Signed | Response> {
    const parsed = JSON.parse(body) as { protected: string; payload: string; signature: string }
    const header = JSON.parse(new TextDecoder().decode(base64urlDecode(parsed.protected))) as {
      nonce: string
      url: string
      kid?: string
      jwk?: Jwk
    }
    if (stale) {
      stale = false
      return problem('badNonce', 'stale nonce', 400, { 'Replay-Nonce': freshNonce() })
    }
    if (!nonces.delete(header.nonce))
      return problem('badNonce', 'unknown nonce', 400, { 'Replay-Nonce': freshNonce() })
    if (header.url !== url) return problem('malformed', 'wrong url', 400)
    const jwk = header.jwk ?? (header.kid ? accounts.get(header.kid) : undefined)
    if (!jwk) return problem('accountDoesNotExist', 'unknown account', 400)
    if (header.kid && (options.alwaysDeactivated || deactivated.has(header.kid))) {
      return problem('unauthorized', "Account is not valid, has status 'deactivated'", 403)
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64urlDecode(parsed.signature) as BufferSource,
      new TextEncoder().encode(`${parsed.protected}.${parsed.payload}`)
    )
    if (!valid) return problem('malformed', 'bad signature', 400)
    const payload =
      parsed.payload === ''
        ? ''
        : JSON.parse(new TextDecoder().decode(base64urlDecode(parsed.payload)))
    log.push({ path: new URL(url).pathname, kid: header.kid ?? null })
    return { kid: header.kid ?? null, jwk, payload }
  }

  const authzBody = async (a: Authz, jwk: Jwk) => {
    let status = 'pending'
    if (a.answered) {
      const thumb = await accountThumbprint({ publicJwk: jwk } as AcmeAccountKey)
      const expected = base64urlEncode(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${a.token}.${thumb}`))
        )
      )
      status = options.txt(`_acme-challenge.${a.identifier}`).includes(expected)
        ? 'valid'
        : 'invalid'
    }
    return {
      status,
      identifier: { type: 'dns', value: a.identifier },
      wildcard: a.wildcard,
      challenges: [
        {
          type: 'dns-01',
          url: `${BASE}/chall/${a.id}`,
          token: a.token,
          status,
          ...(status === 'invalid'
            ? {
                error: { type: 'urn:ietf:params:acme:error:dns', detail: 'no matching TXT record' },
              }
            : {}),
        },
      ],
    }
  }

  const orderBody = async (order: Order, jwk: Jwk) => {
    const states = await Promise.all(order.authz.map((a) => authzBody(a, jwk)))
    const allValid = states.every((s) => s.status === 'valid')
    let status = allValid ? 'ready' : 'pending'
    if (order.finalized) {
      order.polls += 1
      status = order.polls > (options.processingPolls ?? 0) ? 'valid' : 'processing'
    }
    return {
      status,
      identifiers: order.names.map((value) => ({ type: 'dns', value })),
      authorizations: order.authz.map((a) => `${BASE}/authz/${a.id}`),
      finalize: `${BASE}/finalize/${order.id}`,
      ...(status === 'valid' ? { certificate: `${BASE}/cert/${order.id}` } : {}),
    }
  }

  const newOrder = async (signed: Signed, headers: Record<string, string>): Promise<Response> => {
    if (options.busyOrders) {
      const { status, retryAfter } = options.busyOrders
      return problem('serverInternal', 'busy', status, {
        ...headers,
        ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
      })
    }
    if (options.rateLimitOrders) {
      return problem('rateLimited', 'too many new orders', 429, {
        ...headers,
        'Retry-After': '600',
      })
    }
    const names = (signed.payload as { identifiers: { value: string }[] }).identifiers.map(
      (i) => i.value
    )
    const id = next('o')
    const authz = names.map((name) => ({
      id: next('z'),
      identifier: name.replace(/^\*\./, ''),
      wildcard: name.startsWith('*.'),
      token: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
      answered: false,
    }))
    const order: Order = { id, names, authz, finalized: false, polls: 0 }
    orders.push(order)
    return json(await orderBody(order, signed.jwk), {
      status: 201,
      headers: { ...headers, Location: `${BASE}/order/${id}` },
    })
  }

  const handlePost = async (url: string, body: string): Promise<Response> => {
    const path = new URL(url).pathname
    const signed = await open(url, body)
    if (signed instanceof Response) return signed
    const headers = { 'Replay-Nonce': freshNonce() }
    if (path === '/acct') {
      // A key the authority already knows gets its account back, as the protocol says.
      const known = [...accounts].find(([, k]) => k.x === signed.jwk.x && k.y === signed.jwk.y)
      if (known) return json({ status: 'valid' }, { headers: { ...headers, Location: known[0] } })
      const id = `${BASE}/acct/${next('a')}`
      accounts.set(id, signed.jwk)
      return json({ status: 'valid' }, { status: 201, headers: { ...headers, Location: id } })
    }
    if (path === '/order') return await newOrder(signed, headers)
    const [, kind, id] = path.split('/')
    const order = orders.find((o) => o.id === id || o.authz.some((a) => a.id === id))
    if (kind === 'chall') {
      order!.authz.find((a) => a.id === id)!.answered = true
      return json({ status: 'processing' }, { headers })
    }
    if (kind === 'authz') {
      return json(
        await authzBody(
          order!.authz.find((a) => a.id === id)!,
          signed.jwk
        ),
        { headers }
      )
    }
    if (kind === 'order') return json(await orderBody(order!, signed.jwk), { headers })
    if (kind === 'finalize') {
      const csr = base64urlDecode((signed.payload as { csr: string }).csr)
      const names = await verifyCsr(csr)
      if (names.join() !== order!.names.join())
        return problem('badCSR', 'names differ', 400, headers)
      order!.finalized = true
      return json(await orderBody(order!, signed.jwk), { headers })
    }
    if (kind === 'cert') {
      const pem = options.issueCertificate
        ? await options.issueCertificate(order!.names)
        : (await mintSelfSignedCertificate(order!.names)).certificatePem
      issued.push(order!.names)
      return new Response(pem, {
        headers: { ...headers, 'Content-Type': 'application/pem-certificate-chain' },
      })
    }
    return problem('malformed', `unknown path ${path}`, 404, headers)
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string
    if (typeof input === 'string') url = input
    else url = input instanceof URL ? input.href : input.url
    const path = new URL(url).pathname
    if (path === '/directory') {
      hits.directory += 1
      return json({
        newNonce: `${BASE}/nonce`,
        newAccount: `${BASE}/acct`,
        newOrder: `${BASE}/order`,
        ...(options.renewalWindow ? { renewalInfo: `${BASE}/renewal` } : {}),
      })
    }
    if (path.startsWith('/renewal/') && options.renewalWindow) {
      hits.renewal += 1
      renewalAsked.push(path.slice('/renewal/'.length))
      const headers: Record<string, string> = options.renewalRetryAfter
        ? { 'Retry-After': options.renewalRetryAfter }
        : {}
      if (options.renewalBusy) return json({}, { status: 503, headers })
      return json(
        {
          suggestedWindow: {
            start: options.renewalWindow.start.toISOString(),
            end: options.renewalWindow.end.toISOString(),
          },
        },
        { headers }
      )
    }
    if (path === '/nonce') {
      hits.nonce += 1
      return new Response(null, { status: 200, headers: { 'Replay-Nonce': freshNonce() } })
    }
    hits.signed += 1
    return await handlePost(url, typeof init?.body === 'string' ? init.body : '')
  }) as typeof fetch

  return {
    fetch: fakeFetch,
    accounts,
    orders,
    log,
    issued,
    renewalAsked,
    hits,
    deactivateAccounts: () => {
      for (const id of accounts.keys()) deactivated.add(id)
    },
  }
}
