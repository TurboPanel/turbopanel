import { assertEquals } from '@std/assert'
import { CloudflareClient } from './cloudflare-client.ts'
import { createCloudflareAdapter } from './cloudflare-adapter.ts'
import { TunnelProviderError } from './errors.ts'
import { clip } from './scrub.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test}; Sonar only recognizes `test()`. */
const test = Deno.test.bind(Deno)

const TOKEN = 'cf-api-token-0123456789abcdefghijklmnopqrstuv'

/**
 * A fetch that refuses a wrong receiver the way the Workers runtime does: it works as a
 * plain function or on `globalThis`, and throws "Illegal invocation" on any other receiver.
 */
function installWorkersLikeFetch(): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = function (this: unknown, input: Request | URL | string): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
    }
    calls.push(String(input))
    return Promise.resolve(Response.json({ success: true, result: [] }))
  } as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test('the Cloudflare client calls the platform fetch with the right receiver', async () => {
  const stub = installWorkersLikeFetch()
  try {
    await new CloudflareClient({ token: TOKEN }).probeTunnels('a'.repeat(32))
    assertEquals(stub.calls.length, 1)
    assertEquals(stub.calls[0].startsWith('https://api.cloudflare.com/client/v4/accounts/'), true)
  } finally {
    stub.restore()
  }
})

test('the Cloudflare adapter built without an injected fetch reaches the platform fetch', async () => {
  const stub = installWorkersLikeFetch()
  try {
    const adapter = createCloudflareAdapter()
    await adapter.discoverAccounts(TOKEN).catch(() => null)
    assertEquals(stub.calls.length > 0, true)
  } finally {
    stub.restore()
  }
})

test('a stubbed global fetch set after the client is built is still honoured', async () => {
  const client = new CloudflareClient({ token: TOKEN })
  const stub = installWorkersLikeFetch()
  try {
    await client.probeDns('z'.repeat(32))
    assertEquals(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

function refusingFetch(status: number, message: string): typeof fetch {
  return () =>
    Promise.resolve(
      Response.json({ success: false, errors: [{ code: 1022, message }] }, { status })
    )
}

test('a tunnel delete refused for active connections is a conflict, not a provider error', async () => {
  const client = new CloudflareClient({
    token: TOKEN,
    fetch: refusingFetch(400, 'This tunnel has active connections'),
  })
  const err = await client.deleteTunnel('a'.repeat(32), 'tunnel-1').catch((e) => e)
  assertEquals(err instanceof TunnelProviderError, true)
  assertEquals(err.code, 'conflict')
  assertEquals(
    err.message,
    'Cloudflare refused the request (400): This tunnel has active connections'
  )
})

test('any other 400 stays a provider error', async () => {
  const client = new CloudflareClient({ token: TOKEN, fetch: refusingFetch(400, 'Bad name') })
  const err = await client.deleteTunnel('a'.repeat(32), 'tunnel-1').catch((e) => e)
  assertEquals(err.code, 'provider_error')
})

test('a long provider message is cut between words, never inside one', () => {
  const text = `${'word '.repeat(80)}connections`
  const out = clip(text, 50)
  assertEquals(out.length <= 50, true)
  assertEquals(out.endsWith('word…'), true)
  assertEquals(clip('short message'), 'short message')
  assertEquals(clip('x'.repeat(60), 20), `${'x'.repeat(19)}…`)
})
