/** Telling "not an API token" apart from every other Cloudflare refusal. */
import { assertEquals } from '@std/assert'
import { CloudflareClient } from './cloudflare-client.ts'
import { createCloudflareDnsChallenge } from './cloudflare-dns-challenge.ts'
import {
  CLOUDFLARE_TOKEN_FORMAT_MESSAGE,
  cloudflareTokenFormatProblem,
  isTokenFormatRefusal,
} from './cloudflare-token-format.ts'
import { TunnelProviderError } from './errors.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test}; Sonar only recognizes `test()`. */
const test = Deno.test.bind(Deno)

/** What Cloudflare answers when the Authorization value is not shaped like an API token. */
const FORMAT_REFUSAL = {
  success: false,
  errors: [
    {
      code: 6003,
      message: 'Invalid request headers',
      error_chain: [{ code: 6111, message: 'Invalid format for Authorization header' }],
    },
  ],
  messages: [],
  result: null,
}

const refusing = (body: unknown, status: number): typeof fetch => {
  return () => Promise.resolve(Response.json(body, { status }))
}

test('a tunnel run token or text with a stray character is not an API token', () => {
  const runToken = `eyJ${'hIjoiYWJjIiwidCI6ImRlZiIsInMiOiJnaGkifQ'}==`
  assertEquals(cloudflareTokenFormatProblem(runToken), CLOUDFLARE_TOKEN_FORMAT_MESSAGE)
  assertEquals(
    cloudflareTokenFormatProblem('abcdefghij klmnopqrstuvwxyz0123456789ABCD'),
    CLOUDFLARE_TOKEN_FORMAT_MESSAGE
  )
  assertEquals(
    cloudflareTokenFormatProblem('abcdefghij\nklmnopqrstuvwxyz0123456789ABCD'),
    CLOUDFLARE_TOKEN_FORMAT_MESSAGE
  )
  assertEquals(
    cloudflareTokenFormatProblem('abcdefghij​klmnopqrstuvwxyz0123456789ABC'),
    CLOUDFLARE_TOKEN_FORMAT_MESSAGE
  )
})

test('text that could be an API token passes, with space around it ignored', () => {
  assertEquals(cloudflareTokenFormatProblem('AbCd0123456789abcdef0123456789abcdef0123'), null)
  assertEquals(cloudflareTokenFormatProblem(`cfut_${'a'.repeat(40)}abcdef`), null)
  assertEquals(cloudflareTokenFormatProblem(`cfat_${'a'.repeat(40)}abcdef`), null)
  assertEquals(cloudflareTokenFormatProblem('cf-api-token_0123456789abcdefghijklmnopqrst'), null)
  assertEquals(cloudflareTokenFormatProblem('  AbCd0123456789abcdef0123456789abcdef0123\n'), null)
})

test('the format refusal is read from the error code, the error chain or the wording', () => {
  assertEquals(isTokenFormatRefusal(400, FORMAT_REFUSAL.errors), true)
  assertEquals(isTokenFormatRefusal(400, [{ code: 6003 }]), true)
  assertEquals(isTokenFormatRefusal(400, [{ code: 1, error_chain: [{ code: 6111 }] }]), true)
  assertEquals(isTokenFormatRefusal(400, [{ message: 'Invalid request headers' }]), true)
  assertEquals(
    isTokenFormatRefusal(400, [
      { error_chain: [{ message: 'Invalid format for Authorization header' }] },
    ]),
    true
  )
})

test('every other refusal is not a format refusal', () => {
  assertEquals(isTokenFormatRefusal(401, [{ code: 1000, message: 'Invalid API Token' }]), false)
  assertEquals(isTokenFormatRefusal(403, [{ code: 9109, message: 'Unauthorized' }]), false)
  assertEquals(isTokenFormatRefusal(400, [{ code: 1022, message: 'Bad name' }]), false)
  // The wording alone only counts on a 400.
  assertEquals(isTokenFormatRefusal(500, [{ message: 'Invalid request headers' }]), false)
  assertEquals(isTokenFormatRefusal(400, undefined), false)
  assertEquals(isTokenFormatRefusal(400, []), false)
})

test('the tunnel client reports a format refusal in plain words, without the text sent', async () => {
  const sent = '0123456789abcdef0123456789abcdef0123'
  const client = new CloudflareClient({ token: sent, fetch: refusing(FORMAT_REFUSAL, 400) })
  const err = await client.listAccounts().catch((e) => e)
  assertEquals(err instanceof TunnelProviderError, true)
  assertEquals(err.code, 'token_format')
  assertEquals(err.status, 400)
  assertEquals(err.message, CLOUDFLARE_TOKEN_FORMAT_MESSAGE)
  assertEquals(err.message.includes(sent), false)
})

test('a token Cloudflare knows the shape of but rejects stays unauthorized', async () => {
  const body = { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }
  const client = new CloudflareClient({ token: 'a'.repeat(40), fetch: refusing(body, 401) })
  const err = await client.listAccounts().catch((e) => e)
  assertEquals(err.code, 'unauthorized')
})

test('the DNS challenge client reports a format refusal the same way', async () => {
  const dns = createCloudflareDnsChallenge({
    token: 'not a token',
    fetch: refusing(FORMAT_REFUSAL, 400),
  })
  const err = await dns.lookupCname({ zoneId: 'z1', name: 'a.example.com' }).catch((e) => e)
  assertEquals(err instanceof TunnelProviderError, true)
  assertEquals(err.code, 'token_format')
  assertEquals(err.message, CLOUDFLARE_TOKEN_FORMAT_MESSAGE)
})
