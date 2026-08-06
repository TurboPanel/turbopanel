import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import { registerCorsMiddleware } from './cors.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('registerCorsMiddleware is a no-op when origins are blank', async () => {
  const app = new Hono()
  registerCorsMiddleware(app, '   ')
  app.get('/api/health', (c) => c.json({ ok: true }))

  const res = await app.request('http://localhost/api/health', {
    headers: { Origin: 'https://docs.example.com' },
  })
  assertEquals(res.status, 200)
  assertEquals(res.headers.get('Vary'), null)
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), null)
})

test('registerCorsMiddleware parses comma-separated origins with trimming', async () => {
  const app = new Hono()
  registerCorsMiddleware(
    app,
    'https://docs.example.com, https://localhost:19820 ,',
  )
  app.get('/api/client/v1/status', (c) => c.json({ ok: true }))

  const allowed = await app.request('http://localhost/api/client/v1/status', {
    headers: { Origin: 'https://localhost:19820' },
  })
  assertEquals(allowed.status, 200)
  assertEquals(allowed.headers.get('Access-Control-Allow-Origin'), 'https://localhost:19820')

  const denied = await app.request('http://localhost/api/client/v1/status', {
    headers: { Origin: 'https://evil.example' },
  })
  assertEquals(denied.status, 200)
  assertEquals(denied.headers.get('Access-Control-Allow-Origin'), null)
})

test('registerCorsMiddleware advertises read-only methods on allowed preflight', async () => {
  const app = new Hono()
  registerCorsMiddleware(app, 'https://docs.example.com')
  app.post('/api/client/v1/auth/sign-in', (c) => c.json({ ok: true }))

  const preflight = await app.request('http://localhost/api/client/v1/auth/sign-in', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://docs.example.com',
      'Access-Control-Request-Method': 'POST',
    },
  })
  assertEquals(preflight.status, 204)
  const methods = preflight.headers.get('Access-Control-Allow-Methods') ?? ''
  assertEquals(methods.includes('GET'), true)
  assertEquals(methods.includes('HEAD'), true)
  assertEquals(methods.includes('OPTIONS'), true)
  assertEquals(methods.includes('POST'), false)
  assertEquals(preflight.headers.get('Access-Control-Max-Age'), '86400')
})
