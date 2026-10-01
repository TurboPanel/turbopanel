import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from './app.ts'
import { CLIENT_API_PREFIX, DAEMON_API_PREFIX } from './surfaces.ts'
import {
  createWriteRateLimitMiddleware,
  resetWriteRateLimitWarningForTests,
  WRITE_RATE_LIMITED_CODE,
} from './write-rate-limit.ts'
import type { RateLimiter } from '../daemon/rate-limit/contracts.ts'
import { buildSignedCookie, generateSessionToken } from '../client/authn/crypto.ts'
import { HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'

const test = Deno.test.bind(Deno)

const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'workers')
const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')

function countingLimiter(limit: number): RateLimiter & { keys: string[] } {
  const counts = new Map<string, number>()
  const keys: string[] = []
  return {
    keys,
    limit({ key }) {
      keys.push(key)
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      return Promise.resolve({ success: next <= limit })
    },
  }
}

function buildApp(limiter: RateLimiter | undefined): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (limiter) c.set('writeRateLimiter', limiter)
    return next()
  })
  app.use('*', createWriteRateLimitMiddleware({ runtime: 'workers', secrets }))
  app.all('*', (c) => c.json({ ok: true }))
  return app
}

function send(
  app: Hono<AppEnv>,
  opts: { path?: string; method?: string; ip?: string; cookie?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.ip) headers['CF-Connecting-IP'] = opts.ip
  if (opts.cookie) headers.Cookie = `${HTTP_SESSION_COOKIE_NAME}=${opts.cookie}`
  return Promise.resolve(
    app.request(
      new Request(`http://panel.example.com${opts.path ?? `${CLIENT_API_PREFIX}/x`}`, {
        method: opts.method ?? 'POST',
        headers,
        body: ['GET', 'HEAD'].includes(opts.method ?? '') ? undefined : '{}',
      })
    )
  )
}

async function session(): Promise<{ token: string; cookie: string }> {
  const token = generateSessionToken()
  return { token, cookie: encodeURIComponent(await buildSignedCookie(token, secrets)) }
}

test('no limiter injected: writes are never limited', async () => {
  const app = buildApp(undefined)
  for (let i = 0; i < 20; i++) assertEquals((await send(app, { ip: '203.0.113.1' })).status, 200)
})

test('anonymous writes are limited per IP with 429 + Retry-After + stable code', async () => {
  const app = buildApp(countingLimiter(3))
  for (let i = 0; i < 3; i++) assertEquals((await send(app, { ip: '203.0.113.1' })).status, 200)
  const blocked = await send(app, { ip: '203.0.113.1' })
  assertEquals(blocked.status, 429)
  assertEquals(blocked.headers.get('Retry-After'), '60')
  assertEquals((await blocked.json()).code, WRITE_RATE_LIMITED_CODE)
  // Another IP has its own budget.
  assertEquals((await send(app, { ip: '203.0.113.2' })).status, 200)
})

test('signed-in writes are bucketed per session, not per IP', async () => {
  const app = buildApp(countingLimiter(2))
  const a = await session()
  const b = await session()
  assertEquals((await send(app, { ip: '198.51.100.1', cookie: a.cookie })).status, 200)
  // Same session from a different IP still draws on the same bucket.
  assertEquals((await send(app, { ip: '198.51.100.2', cookie: a.cookie })).status, 200)
  assertEquals((await send(app, { ip: '198.51.100.3', cookie: a.cookie })).status, 429)
  // Another session behind the same NAT is unaffected.
  assertEquals((await send(app, { ip: '198.51.100.1', cookie: b.cookie })).status, 200)
})

test('a forged cookie is anonymous (keyed by IP), so rotating fake cookies buys nothing', async () => {
  const app = buildApp(countingLimiter(2))
  for (const forged of ['a.b', 'c.d']) {
    assertEquals((await send(app, { ip: '203.0.113.9', cookie: forged })).status, 200)
  }
  assertEquals((await send(app, { ip: '203.0.113.9', cookie: 'e.f' })).status, 429)
})

test('no verified session and no resolvable IP: not limited (no shared global bucket)', async () => {
  const limiter = countingLimiter(1)
  const app = buildApp(limiter)
  for (let i = 0; i < 5; i++) assertEquals((await send(app)).status, 200)
  assertEquals(limiter.keys.length, 0)
})

test('reads and non-API surfaces are never counted', async () => {
  const limiter = countingLimiter(1)
  const app = buildApp(limiter)
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assertEquals((await send(app, { method, ip: '203.0.113.5' })).status, 200)
  }
  for (const path of [`${DAEMON_API_PREFIX}/x`, '/webhook/github', '/api/health']) {
    for (let i = 0; i < 3; i++)
      assertEquals((await send(app, { path, ip: '203.0.113.5' })).status, 200)
  }
  assertEquals(limiter.keys.length, 0)
})

test('limiter errors fail open', async () => {
  resetWriteRateLimitWarningForTests()
  const app = buildApp({ limit: () => Promise.reject(new Error('redis down')) })
  for (let i = 0; i < 3; i++) assertEquals((await send(app, { ip: '203.0.113.7' })).status, 200)
})

test('bucket keys carry digests only, never the raw token or IP', async () => {
  const limiter = countingLimiter(5)
  const app = buildApp(limiter)
  const s = await session()
  await send(app, { ip: '203.0.113.77', cookie: s.cookie })
  await send(app, { ip: '203.0.113.77' })
  assertEquals(limiter.keys.length, 2)
  assert(limiter.keys[0].startsWith('write:session:'))
  assert(limiter.keys[1].startsWith('write:ip:'))
  assertNotEquals(limiter.keys[0], limiter.keys[1])
  for (const key of limiter.keys) {
    assert(!key.includes(s.token) && !key.includes('203.0.113.77'))
  }
})
