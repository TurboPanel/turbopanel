import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { Hono } from 'hono'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import {
  buildLocalConsoleAuthorization,
  hashLocalConsoleContent,
  LOCAL_CONSOLE_CONTENT_SHA256_HEADER,
  LOCAL_CONSOLE_MAX_SKEW_MS,
  verifyLocalConsoleAuthorization,
} from './local-console-auth.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SECRET = TEST_ONLY_TURBOPANEL_SECRET
const PATH = '/api/developer/v1/daemon/sync-dev'

const ENV_KEYS = [
  'TURBOPANEL_DEV_SURFACE',
  'TURBOPANEL_MODE',
  'TURBOPANEL_UI_MODE',
  'TURBOPANEL_SECRET',
  'TURBOPANEL_SECRETS',
] as const

async function withDevSurface<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) saved.set(key, Deno.env.get(key))
  try {
    Deno.env.set('TURBOPANEL_DEV_SURFACE', '1')
    Deno.env.set('TURBOPANEL_SECRET', SECRET)
    Deno.env.delete('TURBOPANEL_SECRETS')
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

async function signedRequest(opts: {
  method?: string
  url?: string
  body?: string
  timestamp?: string
  contentSha256?: string
  authorization?: string
  mutateAuthPath?: string
  mutateAuthMethod?: string
}): Promise<Request> {
  const method = opts.method ?? 'POST'
  const url = opts.url ?? `http://localhost${PATH}`
  const body = opts.body ?? '{}'
  const requestTarget = new URL(url).pathname + new URL(url).search
  const contentSha256 = opts.contentSha256 ?? await hashLocalConsoleContent(body)
  const timestamp = opts.timestamp ?? new Date().toISOString()
  const authorization = opts.authorization ??
    await buildLocalConsoleAuthorization(
      opts.mutateAuthMethod ?? method,
      opts.mutateAuthPath ?? requestTarget,
      SECRET,
      contentSha256,
      timestamp,
    )
  return new Request(url, {
    method,
    headers: {
      Authorization: authorization,
      [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
      'content-type': 'application/json',
    },
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  })
}

async function verifyRequest(
  request: Request,
  nowMs?: number,
): Promise<boolean> {
  const app = new Hono()
  let result = false
  app.all('*', async (c) => {
    result = await verifyLocalConsoleAuthorization(c, SECRET, nowMs)
    return c.json({ ok: result })
  })
  await app.request(request)
  return result
}

describe('verifyLocalConsoleAuthorization', () => {
  it('accepts a valid signed mutating request within skew', async () => {
    await withDevSurface(async () => {
      const now = Date.now()
      const req = await signedRequest({
        timestamp: new Date(now).toISOString(),
      })
      assertEquals(await verifyRequest(req, now), true)
    })
  })

  it('rejects expired skew', async () => {
    await withDevSurface(async () => {
      const now = Date.now()
      const issued = now - LOCAL_CONSOLE_MAX_SKEW_MS - 1_000
      const req = await signedRequest({
        timestamp: new Date(issued).toISOString(),
      })
      assertEquals(await verifyRequest(req, now), false)
    })
  })

  it('rejects method mismatch', async () => {
    await withDevSurface(async () => {
      const req = await signedRequest({
        method: 'POST',
        mutateAuthMethod: 'PUT',
      })
      assertEquals(await verifyRequest(req), false)
    })
  })

  it('rejects path mismatch', async () => {
    await withDevSurface(async () => {
      const req = await signedRequest({
        mutateAuthPath: '/api/developer/v1/other',
      })
      assertEquals(await verifyRequest(req), false)
    })
  })

  it('rejects query tampering', async () => {
    await withDevSurface(async () => {
      const base = `http://localhost${PATH}?force=1`
      const contentSha256 = await hashLocalConsoleContent('{}')
      const timestamp = new Date().toISOString()
      const authorization = await buildLocalConsoleAuthorization(
        'POST',
        `${PATH}?force=1`,
        SECRET,
        contentSha256,
        timestamp,
      )
      // Replay captured auth against a different query string.
      const tampered = new Request(`http://localhost${PATH}?force=0`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
          'content-type': 'application/json',
        },
        body: '{}',
      })
      assertEquals(await verifyRequest(tampered), false)

      const honest = await signedRequest({ url: base })
      assertEquals(await verifyRequest(honest), true)
    })
  })

  it('rejects body tampering while keeping captured digest/auth headers', async () => {
    await withDevSurface(async () => {
      const originalBody = '{"ok":true}'
      const contentSha256 = await hashLocalConsoleContent(originalBody)
      const timestamp = new Date().toISOString()
      const authorization = await buildLocalConsoleAuthorization(
        'POST',
        PATH,
        SECRET,
        contentSha256,
        timestamp,
      )
      const tampered = new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          [LOCAL_CONSOLE_CONTENT_SHA256_HEADER]: contentSha256,
          'content-type': 'application/json',
        },
        body: '{"ok":false}',
      })
      assertEquals(await verifyRequest(tampered), false)
    })
  })

  it('leaves request body readable after verification', async () => {
    await withDevSurface(async () => {
      const body = '{"ping":true}'
      const req = await signedRequest({ body })
      const app = new Hono()
      let authOk = false
      let seenBody = ''
      app.post('*', async (c) => {
        authOk = await verifyLocalConsoleAuthorization(c, SECRET)
        seenBody = await c.req.text()
        return c.json({ ok: true })
      })
      await app.request(req)
      assertEquals(authOk, true)
      assertEquals(seenBody, body)
    })
  })
})

test('local-console auth suite loaded', () => {
  assertEquals(typeof verifyLocalConsoleAuthorization, 'function')
})
