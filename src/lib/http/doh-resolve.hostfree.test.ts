/**
 * The DNS-over-HTTPS lookup the Workers runtime uses in front of every
 * outbound forge call. It once asked `fetch` for `redirect: 'error'`, which the
 * Workers runtime refuses before sending anything, so every hosted lookup
 * failed (`dns_lookup_failed`) and no GitHub App could be created.
 */
import { assertEquals, assertRejects } from '@std/assert'
import { DOH_ENDPOINT, dohLookup } from './doh-resolve.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Seen = { url: string; init: RequestInit | undefined }

async function withFetch(
  reply: () => Response,
  run: (seen: Seen[]) => Promise<void>
): Promise<void> {
  const original = globalThis.fetch
  const seen: Seen[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init })
    return Promise.resolve(reply())
  }) as typeof fetch
  try {
    await run(seen)
  } finally {
    globalThis.fetch = original
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/dns-json' },
  })

test('asks the resolver with a redirect mode the Workers runtime accepts', async () => {
  await withFetch(
    () => json({ Status: 0, Answer: [{ type: 1, data: '203.0.113.5' }] }),
    async (seen) => {
      assertEquals(await dohLookup('api.github.com', 'A'), ['203.0.113.5'])
      assertEquals(seen.length, 1)
      assertEquals(seen[0]!.url, `${DOH_ENDPOINT}?name=api.github.com&type=A`)
      // Workers only accept 'follow' or 'manual'; 'error' throws before sending.
      assertEquals(seen[0]!.init?.redirect, 'manual')
    }
  )
})

test('a redirect from the resolver is a failure, not followed', async () => {
  await withFetch(
    () => new Response(null, { status: 302, headers: { location: 'https://example.test/' } }),
    async () => {
      await assertRejects(() => dohLookup('api.github.com', 'A'), Error, 'HTTP 302')
    }
  )
})

test('a name with no records of that type answers an empty list', async () => {
  await withFetch(
    () => json({ Status: 0, Question: [{ name: 'api.github.com', type: 28 }] }),
    async () => {
      assertEquals(await dohLookup('api.github.com', 'AAAA'), [])
    }
  )
})

test('NXDOMAIN and other non-NOERROR answers throw', async () => {
  await withFetch(
    () => json({ Status: 3 }),
    async () => {
      await assertRejects(() => dohLookup('nope.invalid', 'A'), Error, 'status 3')
    }
  )
})

test('only address records of the asked type are returned', async () => {
  await withFetch(
    () =>
      json({
        Status: 0,
        Answer: [
          { type: 5, data: 'alias.example.test.' },
          { type: 1, data: '203.0.113.7' },
        ],
      }),
    async () => {
      assertEquals(await dohLookup('www.example.test', 'A'), ['203.0.113.7'])
    }
  )
})
