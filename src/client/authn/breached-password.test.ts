import { assert, assertEquals, assertRejects } from '@std/assert'
import {
  BREACH_PREFIX_LENGTH,
  breachLookupKey,
  checkBreachedPassword,
  fetchBreachRange,
  rangeBodyContains,
} from './breached-password.ts'
import {
  breachedBreachResponder,
  captureWarnings,
  cleanBreachResponder,
  downBreachResponder,
} from '../../test-fixtures/breach.ts'

const test = Deno.test.bind(Deno)

/** Built at run time so secret scanners never read a fixture as a credential. */
function sample(): string {
  return `Aa1-${crypto.randomUUID()}`
}

test('breachLookupKey splits the SHA-1 into a 5-character prefix and a 35-character suffix', async () => {
  // SHA-1("abc") is a published test vector, not a password.
  const { prefix, suffix } = await breachLookupKey('abc')
  assertEquals(prefix, 'A9993')
  assertEquals(suffix, 'E364706816ABA3E25717850C26C9CD0D89D')
  assertEquals(prefix.length, BREACH_PREFIX_LENGTH)
})

test('rangeBodyContains matches a suffix with a positive count and ignores padding rows', () => {
  const body = 'AAAA:0\r\nBBBB:3\nCCCC:12\r\n'
  assertEquals(rangeBodyContains(body, 'BBBB'), true)
  assertEquals(rangeBodyContains(body, 'AAAA'), false)
  assertEquals(rangeBodyContains(body, 'DDDD'), false)
  assertEquals(rangeBodyContains('garbage line\r\nBBBB:x', 'BBBB'), false)
})

test('only the 5-character prefix reaches the responder, never the password or full hash', async () => {
  const password = sample()
  const { prefix, suffix } = await breachLookupKey(password)
  const responder = cleanBreachResponder()
  assertEquals(await checkBreachedPassword(password, responder), 'clean')
  assertEquals(responder.prefixes, [prefix])
  assertEquals(responder.prefixes[0]!.length, 5)
  assert(!responder.prefixes[0]!.includes(suffix))
})

test('a listed suffix is breached; an unrelated range is clean', async () => {
  const password = sample()
  assertEquals(
    await checkBreachedPassword(password, await breachedBreachResponder(password)),
    'breached'
  )
  assertEquals(await checkBreachedPassword(sample(), cleanBreachResponder()), 'clean')
})

test('an unreachable API is "unavailable" (fail-open), logged without the password', async () => {
  const password = sample()
  let result = ''
  const warnings = await captureWarnings(async () => {
    result = await checkBreachedPassword(password, downBreachResponder)
  })
  assertEquals(result, 'unavailable')
  assertEquals(warnings.length, 1)
  assert(warnings[0]!.includes('breached-password check skipped'))
  const { prefix, suffix } = await breachLookupKey(password)
  assert(!warnings[0]!.includes(password) && !warnings[0]!.includes(suffix))
  assert(!warnings[0]!.includes(prefix))
})

test('a responder that hangs is cut off by the 2 s budget and allowed', async () => {
  const hang = (_prefix: string, signal: AbortSignal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  let result = ''
  await captureWarnings(async () => {
    result = await checkBreachedPassword(sample(), hang)
  })
  assertEquals(result, 'unavailable')
})

test('fetchBreachRange sends Add-Padding and only the prefix in the URL', async () => {
  const realFetch = globalThis.fetch
  const seen: { url: string; padding: string | null }[] = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      padding: new Headers(init?.headers).get('Add-Padding'),
    })
    return Promise.resolve(new Response('ABC:1'))
  }) as typeof fetch
  try {
    assertEquals(await fetchBreachRange('A9993', new AbortController().signal), 'ABC:1')
    globalThis.fetch = (() => Promise.resolve(new Response('no', { status: 503 }))) as typeof fetch
    await assertRejects(() => fetchBreachRange('A9993', new AbortController().signal))
  } finally {
    globalThis.fetch = realFetch
  }
  assertEquals(seen, [{ url: 'https://api.pwnedpasswords.com/range/A9993', padding: 'true' }])
})
