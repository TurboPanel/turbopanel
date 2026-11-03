import { assertEquals } from '@std/assert'
import { currentAcmeTermsReader } from './acme-terms.ts'

const test = Deno.test.bind(Deno)

/** A directory stand-in that counts its calls and answers what `answer` says. */
function directory(answer: () => string | Error) {
  let calls = 0
  const fetchFn: typeof fetch = () => {
    calls++
    const next = answer()
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(
      Response.json({
        newNonce: 'https://ca.test/nonce',
        newAccount: 'https://ca.test/account',
        newOrder: 'https://ca.test/order',
        meta: { termsOfService: next },
      })
    )
  }
  return { fetchFn, calls: () => calls }
}

test('the current agreement is read once and kept for ten minutes', async () => {
  let clock = 0
  let terms = 'https://ca.test/v1.pdf'
  const ca = directory(() => terms)
  const read = currentAcmeTermsReader(ca.fetchFn, () => clock)
  assertEquals(await read(), 'https://ca.test/v1.pdf')
  terms = 'https://ca.test/v2.pdf'
  clock += 9 * 60_000
  assertEquals(await read(), 'https://ca.test/v1.pdf')
  assertEquals(ca.calls(), 1)
  clock += 2 * 60_000
  assertEquals(await read(), 'https://ca.test/v2.pdf')
  assertEquals(ca.calls(), 2)
})

test('a failed read answers null and is not tried again for a minute', async () => {
  let clock = 0
  let answer: string | Error = new Error('unreachable')
  const ca = directory(() => answer)
  const read = currentAcmeTermsReader(ca.fetchFn, () => clock)
  assertEquals(await read(), null)
  answer = 'https://ca.test/v1.pdf'
  clock += 30_000
  assertEquals(await read(), null)
  assertEquals(ca.calls(), 1)
  clock += 31_000
  assertEquals(await read(), 'https://ca.test/v1.pdf')
})

test('callers that arrive during a read share it', async () => {
  const ca = directory(() => 'https://ca.test/v1.pdf')
  const read = currentAcmeTermsReader(ca.fetchFn, () => 0)
  assertEquals(await Promise.all([read(), read(), read()]), [
    'https://ca.test/v1.pdf',
    'https://ca.test/v1.pdf',
    'https://ca.test/v1.pdf',
  ])
  assertEquals(ca.calls(), 1)
})

test('an upper-case scheme is stored in its normal form', async () => {
  const ca = directory(() => 'HTTPS://CA.test/Agreement.pdf')
  assertEquals(await currentAcmeTermsReader(ca.fetchFn, () => 0)(), 'https://ca.test/Agreement.pdf')
})
