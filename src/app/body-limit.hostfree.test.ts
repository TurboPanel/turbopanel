import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import {
  createRequestBodyLimitMiddleware,
  DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  LARGE_REQUEST_BODY_LIMIT_BYTES,
  REQUEST_BODY_TOO_LARGE_CODE,
  requestBodyLimitFor,
} from './body-limit.ts'
import { CLIENT_API_PREFIX, DAEMON_API_PREFIX, ADMIN_API_PREFIX } from './surfaces.ts'

const test = Deno.test.bind(Deno)

const MIB = 1024 * 1024

function buildApp(): Hono {
  const app = new Hono()
  app.use('*', createRequestBodyLimitMiddleware())
  // A handler that swallows body-read failures, as several real ones do.
  app.all('*', async (c) => {
    const text = await c.req.text().catch(() => '')
    return c.json({ ok: true, bytes: text.length })
  })
  return app
}

function post(app: Hono, path: string, bytes: number, method = 'POST'): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`https://panel.example.com${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(bytes),
      })
    )
  )
}

function chunked(app: Hono, path: string, chunks: number, chunkBytes: number): Promise<Response> {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close()
        return
      }
      sent += 1
      controller.enqueue(new Uint8Array(chunkBytes))
    },
  })
  return Promise.resolve(
    app.request(
      new Request(`https://panel.example.com${path}`, {
        method: 'POST',
        body,
        // @ts-expect-error duplex is required for streamed request bodies
        duplex: 'half',
      })
    )
  )
}

test('requestBodyLimitFor: default vs compose-bearing client routes', () => {
  assertEquals(
    requestBodyLimitFor(`${CLIENT_API_PREFIX}/servers`),
    DEFAULT_REQUEST_BODY_LIMIT_BYTES
  )
  assertEquals(
    requestBodyLimitFor(`${ADMIN_API_PREFIX}/settings/email`),
    DEFAULT_REQUEST_BODY_LIMIT_BYTES
  )
  for (const rest of [
    '/projects',
    '/projects/p1',
    '/projects/p1/configure',
    '/environments',
    '/environments/e1',
    '/environments/e1/deploy',
    '/docker-run/import',
  ]) {
    assertEquals(
      requestBodyLimitFor(CLIENT_API_PREFIX + rest),
      LARGE_REQUEST_BODY_LIMIT_BYTES,
      rest
    )
  }
  assertEquals(
    requestBodyLimitFor(`${CLIENT_API_PREFIX}/environments/e1/stop`),
    DEFAULT_REQUEST_BODY_LIMIT_BYTES
  )
})

test('body within the default limit passes; over it answers 413 with a stable code', async () => {
  const app = buildApp()
  assertEquals((await post(app, `${CLIENT_API_PREFIX}/servers`, 1000)).status, 200)
  const res = await post(app, `${CLIENT_API_PREFIX}/servers`, MIB + 1)
  assertEquals(res.status, 413)
  const body = await res.json()
  assertEquals(body.ok, false)
  assertEquals(body.code, REQUEST_BODY_TOO_LARGE_CODE)
})

test('applies to PUT, PATCH and DELETE and to admin/install/developer prefixes', async () => {
  const app = buildApp()
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assertEquals((await post(app, `${CLIENT_API_PREFIX}/x`, MIB + 1, method)).status, 413, method)
  }
  for (const prefix of ['/api/admin/v1', '/api/install/v1', '/api/developer/v1']) {
    assertEquals((await post(app, `${prefix}/x`, MIB + 1)).status, 413, prefix)
  }
})

test('chunked body without Content-Length is limited too, even when the handler swallows read errors', async () => {
  const app = buildApp()
  assertEquals((await chunked(app, `${CLIENT_API_PREFIX}/servers`, 4, 1000)).status, 200)
  assertEquals((await chunked(app, `${CLIENT_API_PREFIX}/servers`, 20, 100 * 1024)).status, 413)
})

test('large-body routes allow up to 4 MiB and no more', async () => {
  const app = buildApp()
  assertEquals((await post(app, `${CLIENT_API_PREFIX}/projects`, 2 * MIB)).status, 200)
  assertEquals((await post(app, `${CLIENT_API_PREFIX}/projects`, 4 * MIB + 1)).status, 413)
  assertEquals(
    (await post(app, `${CLIENT_API_PREFIX}/environments/e1`, 3 * MIB, 'PATCH')).status,
    200
  )
})

test('daemon, webhook, health and GET requests are outside the limit', async () => {
  const app = buildApp()
  assertEquals((await post(app, `${DAEMON_API_PREFIX}/secrets/decrypt`, 2 * MIB)).status, 200)
  assertEquals((await post(app, '/webhook/github', 2 * MIB)).status, 200)
  const get = await app.request(
    new Request(`https://panel.example.com${CLIENT_API_PREFIX}/servers`)
  )
  assertEquals(get.status, 200)
})

test('a limited chunked body that fits can still be cloned and re-read (Local-Console HMAC path)', async () => {
  const app = new Hono()
  app.use('*', createRequestBodyLimitMiddleware())
  app.post('*', async (c) => {
    const bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer())
    const text = await c.req.text()
    return c.json({ cloned: bytes.length, text: text.length })
  })
  const res = await chunked(app, '/api/developer/v1/daemon/sync-dev', 3, 10)
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { cloned: 30, text: 30 })
})
