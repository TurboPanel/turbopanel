import { assertEquals } from '@std/assert'
import { Hono, type Context } from 'hono'
import {
  contentLengthExceeds,
  readBodyWithByteLimit,
  readBoundedBodyBytes,
  readBoundedBodyText,
  readBoundedJson,
  rejectIfContentLengthTooLarge,
} from './bounded-body.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** Pull-counting stream: proves a reader stopped early rather than draining it. */
function counterStream(totalChunks: number, chunkSize = 4096): { stream: ReadableStream<Uint8Array>; pulls: () => number } {
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (pulls > totalChunks) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(chunkSize).fill(97))
    },
  })
  return { stream, pulls: () => pulls }
}

/** Runs a handler against a request built with a raw body/init, via Hono. */
async function withContext<T>(
  init: RequestInit,
  handler: (c: Context) => Promise<T>,
): Promise<T> {
  const app = new Hono()
  let result!: T
  app.post('/x', async (c) => {
    result = await handler(c)
    return c.text('ok')
  })
  await app.request('http://instance/x', { method: 'POST', ...init })
  return result
}

test('contentLengthExceeds / rejectIfContentLengthTooLarge: absent or within budget passes', async () => {
  await withContext({ headers: { 'content-length': '10' }, body: '0123456789' }, async (c) => {
    assertEquals(contentLengthExceeds(c, 10), false)
    assertEquals(rejectIfContentLengthTooLarge(c, 10), null)
    return null
  })
})

test('contentLengthExceeds / rejectIfContentLengthTooLarge: over budget is a 413', async () => {
  await withContext({ headers: { 'content-length': '11' }, body: '01234567890' }, async (c) => {
    assertEquals(contentLengthExceeds(c, 10), true)
    const rejected = rejectIfContentLengthTooLarge(c, 10)
    assertEquals(rejected?.status, 413)
    assertEquals(await rejected?.json(), { ok: false, error: 'request body too large' })
    return null
  })
})

test('readBodyWithByteLimit returns the full body when within budget', async () => {
  await withContext({ body: 'hello world' }, async (c) => {
    const result = await readBodyWithByteLimit(c, 100)
    assertEquals(result.ok, true)
    if (result.ok) {
      assertEquals(new TextDecoder().decode(result.bytes), 'hello world')
    }
    return null
  })
})

test('readBodyWithByteLimit aborts the stream as soon as the budget is crossed, without draining it', async () => {
  const { stream, pulls } = counterStream(4096, 4096) // ~16 MiB if fully drained
  const app = new Hono()
  let observedPulls = -1
  let outcome: { ok: boolean } | undefined
  app.post('/x', async (c) => {
    outcome = await readBodyWithByteLimit(c, 4096) // budget: one chunk
    observedPulls = pulls()
    return c.text('ok')
  })
  const init = { method: 'POST', body: stream, duplex: 'half' } as unknown as RequestInit
  await app.request(new Request('http://instance/x', init))
  assertEquals(outcome?.ok, false)
  // A handful of chunks past the budget, nowhere near the 4096 a full drain needs.
  assertEquals(observedPulls < 4096, true)
})

test('readBoundedBodyText: Content-Length precheck short-circuits before any stream read', async () => {
  await withContext(
    { headers: { 'content-length': '999' }, body: '{}' },
    async (c) => {
      const result = await readBoundedBodyText(c, 10)
      assertEquals(result.ok, false)
      if (!result.ok) assertEquals(result.response.status, 413)
      return null
    },
  )
})

test('readBoundedBodyText: streamed body over budget without Content-Length is a 413', async () => {
  const { stream } = counterStream(2048, 1024)
  const app = new Hono()
  let result: { ok: boolean } | undefined
  app.post('/x', async (c) => {
    result = await readBoundedBodyText(c, 1024)
    return c.text('ok')
  })
  const init = { method: 'POST', body: stream, duplex: 'half' } as unknown as RequestInit
  const res = await app.request(new Request('http://instance/x', init))
  assertEquals(result?.ok, false)
  assertEquals(res.status, 200) // the app's own handler ran and returned 'ok' — response building is the caller's job
})

test('readBoundedBodyText: within budget decodes as text', async () => {
  await withContext({ body: 'small body' }, async (c) => {
    const result = await readBoundedBodyText(c, 100)
    assertEquals(result, { ok: true, text: 'small body' })
    return null
  })
})

test('readBoundedBodyBytes mirrors readBoundedBodyText but keeps raw bytes', async () => {
  await withContext({ body: 'raw bytes' }, async (c) => {
    const result = await readBoundedBodyBytes(c, 100)
    assertEquals(result.ok, true)
    if (result.ok) assertEquals(new TextDecoder().decode(result.bytes), 'raw bytes')
    return null
  })
  await withContext({ headers: { 'content-length': '999' }, body: '{}' }, async (c) => {
    const result = await readBoundedBodyBytes(c, 10)
    assertEquals(result, { ok: false })
    return null
  })
})

test('readBoundedJson: valid JSON within budget parses', async () => {
  await withContext(
    { headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
    async (c) => {
      const result = await readBoundedJson(c, 100)
      assertEquals(result, { ok: true, body: { a: 1 } })
      return null
    },
  )
})

test('readBoundedJson: malformed JSON is reason "malformed"', async () => {
  await withContext({ body: 'not json' }, async (c) => {
    const result = await readBoundedJson(c, 100)
    assertEquals(result, { ok: false, reason: 'malformed' })
    return null
  })
})

test('readBoundedJson: empty body is reason "malformed"', async () => {
  await withContext({ body: '' }, async (c) => {
    const result = await readBoundedJson(c, 100)
    assertEquals(result, { ok: false, reason: 'malformed' })
    return null
  })
})

test('readBoundedJson: Content-Length over budget is reason "too-large"', async () => {
  await withContext({ headers: { 'content-length': '999' }, body: '{}' }, async (c) => {
    const result = await readBoundedJson(c, 10)
    assertEquals(result, { ok: false, reason: 'too-large' })
    return null
  })
})

test('readBoundedJson: streamed body over budget without Content-Length is reason "too-large"', async () => {
  const { stream } = counterStream(2048, 1024)
  const app = new Hono()
  let result: unknown
  app.post('/x', async (c) => {
    result = await readBoundedJson(c, 1024)
    return c.text('ok')
  })
  const init = { method: 'POST', body: stream, duplex: 'half' } as unknown as RequestInit
  await app.request(new Request('http://instance/x', init))
  assertEquals(result, { ok: false, reason: 'too-large' })
})
