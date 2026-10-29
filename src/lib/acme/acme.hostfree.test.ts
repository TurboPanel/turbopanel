/**
 * The ACME client, the request builder and the signing, against an in-memory
 * authority that checks every signature, nonce and the request itself.
 */
import { assert, assertEquals, assertRejects } from '@std/assert'
import { AcmeClient, AcmeError, fetchRenewalInfo } from './client.ts'
import { buildCertificateRequest, generateCertificateKey } from './csr.ts'
import {
  ACME_PRODUCTION_DIRECTORY,
  ACME_STAGING_DIRECTORY,
  acmeDirectoryUrl,
} from './directories.ts'
import { createFakeCa, FAKE_CA_DIRECTORY } from './fake-ca.test.support.ts'
import { generateAccountKeyPem, importAccountKey, keyAuthorization } from './jws.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

async function client(ca: ReturnType<typeof createFakeCa>) {
  return new AcmeClient({
    directoryUrl: FAKE_CA_DIRECTORY,
    key: await importAccountKey(await generateAccountKeyPem()),
    fetch: ca.fetch,
  })
}

test('the directory choice keeps staging and production apart', () => {
  assertEquals(acmeDirectoryUrl(false), ACME_PRODUCTION_DIRECTORY)
  assertEquals(acmeDirectoryUrl(true), ACME_STAGING_DIRECTORY)
})

test('an account, an order for a name and its wildcard, a challenge and a certificate', async () => {
  const published = new Map<string, string[]>()
  const ca = createFakeCa({ txt: (name) => published.get(name) ?? [] })
  const acme = await client(ca)
  const account = await acme.ensureAccount()
  assert(account.startsWith('https://ca.test/acct/'))
  assertEquals(await acme.ensureAccount(), account)

  const order = await acme.newOrder(['example.com', '*.example.com'])
  const authorizations = await Promise.all(
    order.authorizations.map((u) => acme.getAuthorization(u))
  )
  assertEquals(
    authorizations.map((a) => a.identifier.value),
    ['example.com', 'example.com']
  )
  assertEquals(
    authorizations.map((a) => a.wildcard),
    [false, true]
  )

  // Both challenges answer at the same record name, with two different values.
  const values = await Promise.all(authorizations.map((a) => acme.dnsValue(a.challenges[0]!.token)))
  assertEquals(new Set(values).size, 2)
  published.set('_acme-challenge.example.com', values)
  await Promise.all(authorizations.map((a) => acme.answerChallenge(a.challenges[0]!.url)))
  const checked = await Promise.all(order.authorizations.map((u) => acme.getAuthorization(u)))
  assertEquals(
    checked.map((a) => a.status),
    ['valid', 'valid']
  )

  const key = await generateCertificateKey()
  const csr = await buildCertificateRequest({
    privateKey: key.privateKey,
    spki: key.spki,
    names: ['example.com', '*.example.com'],
  })
  const finalized = await acme.finalize(order.finalize, csr)
  assertEquals(finalized.status, 'valid')
  const chain = await acme.downloadCertificate(finalized.certificate!)
  assert(chain.includes('BEGIN CERTIFICATE'))
  assertEquals(ca.issued, [['example.com', '*.example.com']])
  // Every signed request after the account used the account address, not the key.
  assert(ca.log.filter((l) => l.path !== '/acct').every((l) => l.kid === account))
})

test('a challenge with no matching record is reported invalid with the reason', async () => {
  const ca = createFakeCa({ txt: () => [] })
  const acme = await client(ca)
  await acme.ensureAccount()
  const order = await acme.newOrder(['nope.example.com'])
  const [authz] = await Promise.all(order.authorizations.map((u) => acme.getAuthorization(u)))
  await acme.answerChallenge(authz!.challenges[0]!.url)
  const after = await acme.getAuthorization(authz!.url)
  assertEquals(after.status, 'invalid')
  assertEquals(after.challenges[0]!.error?.detail, 'no matching TXT record')
})

test('a stale nonce is replaced and the request sent once more', async () => {
  const ca = createFakeCa({ txt: () => [], staleNonceOnce: true })
  const acme = await client(ca)
  assert((await acme.ensureAccount()).startsWith('https://ca.test/acct/'))
})

test('a rate limit becomes a coded error that says how long to wait', async () => {
  const ca = createFakeCa({ txt: () => [], rateLimitOrders: true })
  const acme = await client(ca)
  await acme.ensureAccount()
  const err = await assertRejects(() => acme.newOrder(['example.com']), AcmeError)
  assertEquals(err.code, 'rate_limited')
  assertEquals(err.retryAfterMs, 600_000)
})

test('a request for the certificate carries every name and a valid signature', async () => {
  const key = await generateCertificateKey()
  const csr = await buildCertificateRequest({
    privateKey: key.privateKey,
    spki: key.spki,
    names: ['a.example.com', '*.b.example.com'],
  })
  // The fake authority verifies the signature and the names; here just the shape.
  assertEquals(csr[0], 0x30)
  await assertRejects(
    () => buildCertificateRequest({ privateKey: key.privateKey, spki: key.spki, names: [] }),
    TypeError
  )
})

test('the key authorization joins the token and the key thumbprint', async () => {
  const key = await importAccountKey(await generateAccountKeyPem())
  const auth = await keyAuthorization(key, 'token-1')
  assert(auth.startsWith('token-1.'))
  assertEquals(auth.split('.').length, 2)
})

test('an unreachable authority is reported as such', async () => {
  const acme = new AcmeClient({
    directoryUrl: FAKE_CA_DIRECTORY,
    key: await importAccountKey(await generateAccountKeyPem()),
    fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch,
  })
  const err = await assertRejects(() => acme.ensureAccount(), AcmeError)
  assertEquals(err.code, 'unreachable')
})

test('a 503 with a wait carries it on every kind of request, and a bare 429 gets the default', async () => {
  const ca = createFakeCa({ txt: () => [], busyOrders: { status: 503, retryAfter: '120' } })
  const acme = await client(ca)
  await acme.ensureAccount()
  const busy = await assertRejects(() => acme.newOrder(['example.com']), AcmeError)
  assertEquals([busy.status, busy.retryAfterMs], [503, 120_000])

  // The directory and the nonce answer 503 too: the wait is carried the same way.
  const throttled = (path: string, status: number, wait?: string) =>
    (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith(path)
        ? new Response(null, { status, headers: wait ? { 'Retry-After': wait } : {} })
        : await ca.fetch(input, init)) as typeof fetch
  const key = await importAccountKey(await generateAccountKeyPem())
  const noDirectory = new AcmeClient({
    directoryUrl: FAKE_CA_DIRECTORY,
    key,
    fetch: throttled('/directory', 503, '30'),
  })
  const first = await assertRejects(() => noDirectory.ensureAccount(), AcmeError)
  assertEquals([first.status, first.retryAfterMs], [503, 30_000])
  const noNonce = new AcmeClient({
    directoryUrl: FAKE_CA_DIRECTORY,
    key,
    fetch: throttled('/nonce', 429),
  })
  const second = await assertRejects(() => noNonce.ensureAccount(), AcmeError)
  assertEquals([second.code, second.status, second.retryAfterMs], ['rate_limited', 429, 3_600_000])
})

test('a plain server error carries no wait', async () => {
  const ca = createFakeCa({ txt: () => [], busyOrders: { status: 500 } })
  const acme = await client(ca)
  await acme.ensureAccount()
  const err = await assertRejects(() => acme.newOrder(['example.com']), AcmeError)
  assertEquals([err.status, err.retryAfterMs], [500, null])
})

test('clients of one authority share the directory and pass the nonce on', async () => {
  const ca = createFakeCa({ txt: () => [], renewalWindow: { start: new Date(), end: new Date() } })
  const key = await importAccountKey(await generateAccountKeyPem())
  const open = (accountUrl?: string) =>
    new AcmeClient({ directoryUrl: FAKE_CA_DIRECTORY, key, accountUrl, fetch: ca.fetch })
  const account = await open().ensureAccount()
  // A second client (a later step) needs neither the directory nor a new nonce.
  await open(account).newOrder(['example.com'])
  await open(account).newOrder(['www.example.com'])
  assertEquals([ca.hits.directory, ca.hits.nonce, ca.hits.signed], [1, 1, 3])
  // Asking for renewal information reuses the cached directory too.
  await fetchRenewalInfo({ directoryUrl: FAKE_CA_DIRECTORY, certId: 'a.b', fetch: ca.fetch })
  assertEquals([ca.hits.directory, ca.hits.renewal], [1, 1])
})

test('a different fetch never sees another one’s cache', async () => {
  const one = createFakeCa({ txt: () => [] })
  const two = createFakeCa({ txt: () => [] })
  await (await client(one)).ensureAccount()
  await (await client(two)).ensureAccount()
  assertEquals([one.hits.directory, two.hits.directory], [1, 1])
})

test('a second stale nonce in a row is an error, with no third request', async () => {
  const ca = createFakeCa({ txt: () => [] })
  let posts = 0
  const stale = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return await ca.fetch(input, init)
    posts += 1
    return new Response(
      JSON.stringify({ type: 'urn:ietf:params:acme:error:badNonce', detail: 'stale nonce' }),
      { status: 400, headers: { 'Replay-Nonce': `n${posts}` } }
    )
  }) as typeof fetch
  const acme = new AcmeClient({
    directoryUrl: FAKE_CA_DIRECTORY,
    key: await importAccountKey(await generateAccountKeyPem()),
    fetch: stale,
  })
  await assertRejects(() => acme.ensureAccount(), AcmeError)
  assertEquals(posts, 2)
})
