import { assert, assertEquals, assertRejects } from '@std/assert'
import {
  buildIngress,
  cloudflareTokenProblem,
  createCloudflareAdapter,
} from './cloudflare-adapter.ts'
import { TunnelProviderError } from './errors.ts'
import { scrubSecrets } from './scrub.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const TOKEN = 'cf-api-token-0123456789abcdefghijklmnopqrstuv'
const ACCOUNT = 'a'.repeat(32)

type Call = { method: string; url: string; auth: string | null; body: unknown }
type Reply = { status?: number; body: unknown }

/** A fetch that answers from a table keyed by `METHOD path` and records each call. */
function fakeFetch(routes: Record<string, Reply>) {
  const calls: Call[] = []
  const impl: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({
      method,
      url: url.pathname + url.search,
      auth: headers.get('Authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const reply = routes[`${method} ${url.pathname}`]
    if (!reply)
      return Promise.resolve(Response.json({ success: false, errors: [] }, { status: 404 }))
    return Promise.resolve(Response.json(reply.body, { status: reply.status ?? 200 }))
  }
  return { impl, calls }
}

const ok = (result: unknown) => ({ body: { success: true, errors: [], result } })
const refused = (status: number, message: string): Reply => ({
  status,
  body: { success: false, errors: [{ code: 1, message }] },
})

test('a token that reaches tunnels and DNS is reported with its zones and no missing permission', async () => {
  const { impl, calls } = fakeFetch({
    'GET /client/v4/accounts': ok([{ id: ACCOUNT, name: 'Main' }]),
    'GET /client/v4/zones': ok([{ id: 'z1', name: 'example.com' }]),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
    'GET /client/v4/zones/z1/dns_records': ok([]),
  })
  const report = await createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, {
    accountId: ACCOUNT,
  })
  assertEquals(report.capabilities, {
    tunnels: true,
    dns: [{ id: 'z1', name: 'example.com' }],
    certificates: [],
  })
  assertEquals(report.missing, [])
  assertEquals(report.zones, [{ id: 'z1', name: 'example.com' }])
  assert(report.accountVisible)
  // Only reads, and the token travels only in the header.
  assert(calls.every((c) => c.method === 'GET' && c.auth === `Bearer ${TOKEN}`))
  assert(calls.every((c) => !c.url.includes(TOKEN)))
})

test('a token without DNS access names the missing permission', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/accounts': ok([{ id: ACCOUNT, name: 'Main' }]),
    'GET /client/v4/zones': ok([{ id: 'z1', name: 'example.com' }]),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
    'GET /client/v4/zones/z1/dns_records': refused(403, 'Authentication error'),
  })
  const report = await createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, {
    accountId: ACCOUNT,
  })
  assertEquals(report.capabilities.tunnels, true)
  assertEquals(report.capabilities.dns, [])
  assertEquals(report.missing, ['Zone · DNS · Edit'])
})

test('a token refused the account and zone lists is judged by the probes, not rejected', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/accounts': refused(403, 'forbidden'),
    'GET /client/v4/zones': refused(403, 'forbidden'),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
  })
  const report = await createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, {
    accountId: ACCOUNT,
  })
  assertEquals(report.capabilities.tunnels, true)
  assertEquals(report.capabilities.dns, [])
  assert(report.accountVisible)
})

test('an account the token cannot see is reported as not visible', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/accounts': ok([{ id: 'b'.repeat(32), name: 'Other' }]),
    'GET /client/v4/zones': ok([]),
  })
  const report = await createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, {
    accountId: ACCOUNT,
  })
  assertEquals(report.accountVisible, false)
  assertEquals(report.capabilities.tunnels, false)
})

test('a token the provider rejects fails with an unauthorized error free of the token', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/accounts': refused(401, `Invalid token ${TOKEN}`),
  })
  const err = await assertRejects(
    () => createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, { accountId: ACCOUNT }),
    TunnelProviderError
  )
  assertEquals(err.code, 'unauthorized')
  assert(!err.message.includes(TOKEN))
})

test('a network failure that echoes the token is scrubbed', async () => {
  const impl: typeof fetch = () =>
    Promise.reject(new TypeError(`connect failed for Bearer ${TOKEN}`))
  const err = await assertRejects(
    () => createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, { accountId: ACCOUNT }),
    TunnelProviderError
  )
  assertEquals(err.code, 'unreachable')
  assert(!err.message.includes(TOKEN))
  assert(!JSON.stringify(err).includes(TOKEN))
})

test('creating a tunnel asks for a remotely managed tunnel and fetches the run token when none is returned', async () => {
  const { impl, calls } = fakeFetch({
    [`POST /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: ok({ id: 't-1', name: 'web' }),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel/t-1/token`]: ok('run-token-value'),
  })
  const created = await createCloudflareAdapter({ fetch: impl }).createTunnel(TOKEN, {
    accountId: ACCOUNT,
    name: 'web',
  })
  assertEquals(created, { externalId: 't-1', runToken: 'run-token-value' })
  assertEquals(calls[0]!.body, { name: 'web', config_src: 'cloudflare' })
})

test('routes end with a catch-all and point every name at the local web server', async () => {
  const rules = buildIngress(['A.example.com', 'a.example.com', 'b.example.com'])
  assertEquals(rules.length, 3)
  assertEquals(rules[0]!.hostname, 'a.example.com')
  assertEquals(rules[0]!.service, 'https://localhost')
  assertEquals(rules[2], { service: 'http_status:404' })

  const { impl, calls } = fakeFetch({
    [`PUT /client/v4/accounts/${ACCOUNT}/cfd_tunnel/t-1/configurations`]: ok({}),
  })
  await createCloudflareAdapter({ fetch: impl }).setRoutes(TOKEN, {
    accountId: ACCOUNT,
    externalId: 't-1',
    hostnames: ['a.example.com'],
  })
  const body = calls[0]!.body as { config: { ingress: { hostname?: string; service: string }[] } }
  assertEquals(body.config.ingress.at(-1), { service: 'http_status:404' })
})

test('the DNS name is a proxied CNAME to the tunnel', async () => {
  const { impl, calls } = fakeFetch({
    'POST /client/v4/zones/z1/dns_records': ok({ id: 'r-1' }),
    'DELETE /client/v4/zones/z1/dns_records/r-1': ok({ id: 'r-1' }),
  })
  const adapter = createCloudflareAdapter({ fetch: impl })
  const made = await adapter.createDnsName(TOKEN, {
    zoneId: 'z1',
    hostname: 'a.example.com',
    externalId: 't-1',
  })
  assertEquals(made, { recordId: 'r-1' })
  assertEquals(calls[0]!.body, {
    type: 'CNAME',
    name: 'a.example.com',
    content: 't-1.cfargotunnel.com',
    proxied: true,
    ttl: 1,
  })
  await adapter.removeDnsName(TOKEN, { zoneId: 'z1', recordId: 'r-1' })
  assertEquals(calls[1]!.method, 'DELETE')
})

test('deleting a tunnel and rotating a run token behave as documented', async () => {
  const { impl, calls } = fakeFetch({
    [`DELETE /client/v4/accounts/${ACCOUNT}/cfd_tunnel/t-1`]: ok({}),
  })
  const adapter = createCloudflareAdapter({ fetch: impl })
  await adapter.deleteTunnel(TOKEN, { accountId: ACCOUNT, externalId: 't-1' })
  assertEquals(calls[0]!.method, 'DELETE')
  const err = await assertRejects(
    () => adapter.rotateRunToken(TOKEN, { accountId: ACCOUNT, externalId: 't-1' }),
    TunnelProviderError
  )
  assertEquals(err.code, 'unsupported')
})

test('scrubbing removes known secrets, bearer values and token-shaped runs', () => {
  const text = `bad ${TOKEN} header Bearer abc.def-ghi and blob ${'Z'.repeat(40)}`
  const out = scrubSecrets(text, [TOKEN])
  assert(!out.includes(TOKEN))
  assert(!out.includes('abc.def-ghi'))
  assert(!out.includes('Z'.repeat(40)))
})

test('the zone for a hostname is searched only in the tunnel account and the longest match wins', async () => {
  const { impl, calls } = fakeFetch({
    'GET /client/v4/zones': ok([
      { id: 'z1', name: 'example.com', account: { id: ACCOUNT } },
      { id: 'z2', name: 'shop.example.com', account: { id: ACCOUNT } },
      { id: 'z3', name: 'other.org', account: { id: 'b'.repeat(32) } },
    ]),
    'GET /client/v4/zones/z1/dns_records': ok([]),
    'GET /client/v4/zones/z2/dns_records': ok([]),
  })
  const adapter = createCloudflareAdapter({ fetch: impl })
  const zone = await adapter.findZone(TOKEN, { accountId: ACCOUNT, hostname: 'a.shop.example.com' })
  assertEquals(zone, { id: 'z2', name: 'shop.example.com' })
  assert(calls[0]!.url.includes(`account.id=${ACCOUNT}`))
  const err = await assertRejects(
    () => adapter.findZone(TOKEN, { accountId: ACCOUNT, hostname: 'www.other.org' }),
    TunnelProviderError
  )
  assertEquals(err.code, 'zone_not_found')
  const lookalike = await assertRejects(
    () => adapter.findZone(TOKEN, { accountId: ACCOUNT, hostname: 'notexample.com' }),
    TunnelProviderError
  )
  assertEquals(lookalike.code, 'zone_not_found')
})

test('a zone the token cannot reach is skipped in favor of a shorter one it can', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/zones': ok([
      { id: 'z1', name: 'example.com', account: { id: ACCOUNT } },
      { id: 'z2', name: 'shop.example.com', account: { id: ACCOUNT } },
    ]),
    'GET /client/v4/zones/z1/dns_records': ok([]),
    'GET /client/v4/zones/z2/dns_records': refused(403, 'denied'),
  })
  const zone = await createCloudflareAdapter({ fetch: impl }).findZone(TOKEN, {
    accountId: ACCOUNT,
    hostname: 'a.shop.example.com',
  })
  assertEquals(zone.id, 'z1')
})

test('a token limited to some zones lists only those zones as DNS rights', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/accounts': ok([{ id: ACCOUNT, name: 'Main' }]),
    'GET /client/v4/zones': ok([
      { id: 'z1', name: 'example.com' },
      { id: 'z2', name: 'other.com' },
    ]),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
    'GET /client/v4/zones/z1/dns_records': ok([]),
    'GET /client/v4/zones/z2/dns_records': refused(403, 'denied'),
  })
  const report = await createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, {
    accountId: ACCOUNT,
  })
  assertEquals(report.capabilities.dns, [{ id: 'z1', name: 'example.com' }])
  assertEquals(report.missing, [])
})

test('a Global API Key is refused in both its old and new formats, an API token is not', () => {
  assert(cloudflareTokenProblem('0123456789abcdef0123456789abcdef01234') !== null) // 37 hex
  assert(cloudflareTokenProblem('0123456789abcdef0123456789abcdef0123456789abc') !== null) // 45 hex
  assert(cloudflareTokenProblem(`cfk_${'A'.repeat(40)}checksum`) !== null)
  assert(cloudflareTokenProblem('cf-api-token-0123456789abcdefghijklmnopqrstuv') === null)
  assert(cloudflareTokenProblem(`cfat_${'a'.repeat(40)}abcdef`) === null)
  assert(cloudflareTokenProblem(`cfut_${'a'.repeat(40)}abcdef`) === null)
  assert(cloudflareTokenProblem('0123456789abcdef0123456789abcdef0123') === null) // 36 hex is not a key
  assert(cloudflareTokenProblem('AbCd0123456789abcdef0123456789abcdef0123') === null) // mixed case
})

test('an account-owned token is verified at the account endpoint and its expiry is reported', async () => {
  const expires = '2027-03-01T00:00:00Z'
  const { impl, calls } = fakeFetch({
    'GET /client/v4/accounts': ok([{ id: ACCOUNT, name: 'Main' }]),
    'GET /client/v4/zones': ok([]),
    [`GET /client/v4/accounts/${ACCOUNT}/tokens/verify`]: ok({
      id: 'tok-1',
      status: 'active',
      expires_on: expires,
    }),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
  })
  const report = await createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, {
    accountId: ACCOUNT,
  })
  assertEquals(report.token, { kind: 'account', id: 'tok-1', status: 'active', expiresAt: expires })
  // The account endpoint answered, so the user endpoint was never needed.
  assert(!calls.some((c) => c.url.startsWith('/client/v4/user/tokens/verify')))
})

test('a user-owned token falls back to the user endpoint, and the prefix names the kind', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/accounts': ok([{ id: ACCOUNT, name: 'Main' }]),
    'GET /client/v4/zones': ok([]),
    'GET /client/v4/user/tokens/verify': ok({ id: 'tok-2', status: 'active' }),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: ok([]),
  })
  const adapter = createCloudflareAdapter({ fetch: impl })
  const plain = await adapter.checkCredential(TOKEN, { accountId: ACCOUNT })
  assertEquals(plain.token.kind, 'user')
  assertEquals(plain.token.expiresAt, null)
  const prefixed = await adapter.checkCredential(`cfut_${'a'.repeat(40)}`, { accountId: ACCOUNT })
  assertEquals(prefixed.token.kind, 'user')
})

test('discovering accounts lists what a pasted token reaches and who owns it', async () => {
  const { impl } = fakeFetch({
    'GET /client/v4/accounts': ok([
      { id: ACCOUNT, name: 'Main' },
      { id: 'b'.repeat(32), name: 'Second' },
    ]),
    'GET /client/v4/user/tokens/verify': ok({ id: 'tok-3', status: 'active' }),
  })
  const found = await createCloudflareAdapter({ fetch: impl }).discoverAccounts(TOKEN)
  assertEquals(found.accounts.length, 2)
  assertEquals(found.token.kind, 'user')
  assertEquals(found.token.id, 'tok-3')
})

test('zones the person names are probed one by one, so a token that cannot list zones still covers them', async () => {
  const { impl, calls } = fakeFetch({
    'GET /client/v4/accounts': refused(403, 'denied'),
    'GET /client/v4/zones': refused(403, 'denied'),
    [`GET /client/v4/accounts/${ACCOUNT}/cfd_tunnel`]: refused(403, 'denied'),
    'GET /client/v4/zones/z9/dns_records': ok([]),
    'GET /client/v4/zones/z9': ok({ id: 'z9', name: 'shop.example.org', account: { id: ACCOUNT } }),
    'GET /client/v4/zones/z8/dns_records': ok([]),
    'GET /client/v4/zones/z8': refused(403, 'denied'),
    'GET /client/v4/zones/z7/dns_records': ok([]),
    'GET /client/v4/zones/z7': ok({ id: 'z7', name: 'other.net', account: { id: 'b'.repeat(32) } }),
  })
  const report = await createCloudflareAdapter({ fetch: impl }).checkCredential(TOKEN, {
    accountId: ACCOUNT,
    declaredZones: [
      { id: 'z9', name: '' },
      { id: 'z8', name: 'docs.example.net' },
      { id: 'z7', name: '' },
      { id: 'z5', name: 'gone.dev' },
    ],
  })
  assertEquals(report.declared, [
    { id: 'z9', name: 'shop.example.org', reachable: true, accountMatch: true },
    { id: 'z8', name: 'docs.example.net', reachable: true, accountMatch: null },
    { id: 'z7', name: 'other.net', reachable: true, accountMatch: false },
    { id: 'z5', name: 'gone.dev', reachable: false, accountMatch: null },
  ])
  // Reached zones count as DNS rights; a zone of another account and an unreachable one do not.
  assertEquals(report.capabilities.dns.map((z) => z.id).sort(), ['z8', 'z9'])
  assertEquals(report.capabilities.tunnels, false)
  assert(calls.every((c) => c.method === 'GET'))
})
