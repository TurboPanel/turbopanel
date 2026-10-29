/** The Cloudflare TXT records of a DNS challenge: shapes, ids and scrubbed errors. */
import { assertEquals, assertRejects } from '@std/assert'
import { createCloudflareDnsChallenge } from './cloudflare-dns-challenge.ts'
import { TunnelProviderError } from './errors.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (typescript:S2187). */
const test = Deno.test.bind(Deno)

const TOKEN = 'tok_secret_value_123456'

type Call = { method: string; url: string; body: unknown; auth: string | null }

function recorder(reply: (call: Call) => Response) {
  const calls: Call[] = []
  const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get('authorization'),
    }
    calls.push(call)
    return Promise.resolve(reply(call))
  }) as typeof fetch
  return { calls, fetch: fakeFetch }
}

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }))

test('a challenge record is a short-lived TXT record and comes back as an id', async () => {
  const api = recorder(() => ok({ id: 'rec1' }))
  const dns = createCloudflareDnsChallenge({ token: TOKEN, fetch: api.fetch })
  const ref = await dns.present({ zoneId: 'z1', name: '_acme-challenge.example.com', value: 'v1' })
  assertEquals(ref, { zoneId: 'z1', recordId: 'rec1' })
  assertEquals(api.calls[0]!.method, 'POST')
  assertEquals(api.calls[0]!.url, 'https://api.cloudflare.com/client/v4/zones/z1/dns_records')
  assertEquals(api.calls[0]!.body, {
    type: 'TXT',
    name: '_acme-challenge.example.com',
    content: 'v1',
    ttl: 60,
  })
  assertEquals(api.calls[0]!.auth, `Bearer ${TOKEN}`)
})

test('two records at one name are kept apart by their ids', async () => {
  let n = 0
  const api = recorder(() => ok({ id: `rec${(n += 1)}` }))
  const dns = createCloudflareDnsChallenge({ token: TOKEN, fetch: api.fetch })
  const a = await dns.present({ zoneId: 'z', name: '_acme-challenge.x.com', value: 'a' })
  const b = await dns.present({ zoneId: 'z', name: '_acme-challenge.x.com', value: 'b' })
  await dns.remove(a)
  assertEquals(b.recordId, 'rec2')
  assertEquals(api.calls[2]!.method, 'DELETE')
  assertEquals(api.calls[2]!.url.endsWith('/zones/z/dns_records/rec1'), true)
})

test('removing a record that is already gone is not an error', async () => {
  const api = recorder(
    () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'gone' }] }), {
        status: 404,
      })
  )
  const dns = createCloudflareDnsChallenge({ token: TOKEN, fetch: api.fetch })
  await dns.remove({ zoneId: 'z', recordId: 'missing' })
})

test('a refusal says what happened without the token', async () => {
  const api = recorder(
    () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ message: `bad token ${TOKEN}` }] }),
        { status: 403 }
      )
  )
  const dns = createCloudflareDnsChallenge({ token: TOKEN, fetch: api.fetch })
  const err = await assertRejects(
    () => dns.present({ zoneId: 'z', name: '_acme-challenge.x.com', value: 'v' }),
    TunnelProviderError
  )
  assertEquals(err.code, 'forbidden')
  assertEquals(err.message.includes(TOKEN), false)
})

test('an unreachable provider does not leak the token either', async () => {
  const dns = createCloudflareDnsChallenge({
    token: TOKEN,
    fetch: (() => Promise.reject(new Error(`connect failed for ${TOKEN}`))) as typeof fetch,
  })
  const err = await assertRejects(
    () => dns.present({ zoneId: 'z', name: '_acme-challenge.x.com', value: 'v' }),
    TunnelProviderError
  )
  assertEquals(err.code, 'unreachable')
  assertEquals(err.message.includes(TOKEN), false)
})

test('a reply without a record id is an error, not a silent success', async () => {
  const api = recorder(() => ok({}))
  const dns = createCloudflareDnsChallenge({ token: TOKEN, fetch: api.fetch })
  await assertRejects(
    () => dns.present({ zoneId: 'z', name: '_acme-challenge.x.com', value: 'v' }),
    TunnelProviderError
  )
})

test('a 429 or 503 carries the wait the host asked for', async () => {
  const api = recorder(
    () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: 'slow' }] }), {
        status: 429,
        headers: { 'Retry-After': '90' },
      })
  )
  const dns = createCloudflareDnsChallenge({ token: TOKEN, fetch: api.fetch })
  const err = await assertRejects(
    () => dns.present({ zoneId: 'z1', name: '_acme-challenge.example.com', value: 'v1' }),
    TunnelProviderError
  )
  assertEquals([err.code, err.status, err.retryAfterMs], ['rate_limited', 429, 90_000])
})
