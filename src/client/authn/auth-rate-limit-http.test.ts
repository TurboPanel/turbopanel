import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { Hono } from 'hono'
import { createApp, type AppEnv } from '../../app.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { registerAuthRoutes, resolveClientIp } from './http.ts'
import {
  type AuthRateLimiter,
  createAuthRateLimiter,
  createDurableAuthRateLimiter,
  createFailClosedAuthRateLimiter,
} from './auth-rate-limit.ts'
import { createRedisRateLimiter } from '../../daemon/rate-limit/redis-rate-limiter.ts'
import type { RedisCellClient } from '../../daemon/cell/redis/client.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'

/**
 * Build an app with the auth limiter injected through the request context, the
 * same channel the per-runtime entrypoints use to supply a durable limiter.
 */
async function buildApp(
  limiter: AuthRateLimiter | undefined,
  runtime: 'deno' | 'workers' = 'workers',
): Promise<Hono<AppEnv>> {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    runtime,
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  const app = new Hono<AppEnv>()
  const client = new Hono<AppEnv>()
  if (limiter) {
    client.use('*', (c, next) => {
      c.set('authRateLimiter', limiter)
      return next()
    })
  }
  registerAuthRoutes(client as unknown as Hono, {
    secrets,
    otpVerifierSecrets,
    runtime,
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return app
}

describe('resolveClientIp', () => {
  it('Workers prefers CF-Connecting-IP and ignores spoofed forwarding headers', async () => {
    const app = new Hono()
    let resolved: string | null = 'unset'
    app.get('/ip', (c) => {
      resolved = resolveClientIp(c, 'workers')
      return c.text('ok')
    })

    // Forged X-Real-IP / X-Forwarded-For must not win on Workers.
    await app.request('/ip', {
      headers: {
        'X-Real-IP': '198.51.100.1',
        'X-Forwarded-For': '198.51.100.2',
        'CF-Connecting-IP': '203.0.113.44',
      },
    })
    assertEquals(resolved, '203.0.113.44')
  })

  it('Workers ignores client-supplied X-Real-IP when CF-Connecting-IP is absent', async () => {
    const app = new Hono()
    let resolved: string | null = 'unset'
    app.get('/ip', (c) => {
      resolved = resolveClientIp(c, 'workers')
      return c.text('ok')
    })

    await app.request('/ip', {
      headers: {
        'X-Real-IP': '198.51.100.1',
        'X-Forwarded-For': '198.51.100.2',
      },
    })
    assertEquals(resolved, null)
  })

  it('Deno trusts X-Real-IP from the local proxy and ignores X-Forwarded-For', async () => {
    const app = new Hono()
    let resolved: string | null = 'unset'
    app.get('/ip', (c) => {
      resolved = resolveClientIp(c, 'deno')
      return c.text('ok')
    })

    await app.request('/ip', {
      headers: {
        'X-Real-IP': '203.0.113.50',
        'X-Forwarded-For': '198.51.100.9',
      },
    })
    assertEquals(resolved, '203.0.113.50')
  })
})

it('sign-in returns 429 with Retry-After once the limiter blocks', async () => {
  // limit 1 per window: first attempt allowed, second blocked.
  const app = await buildApp(
    createAuthRateLimiter({ defaultPolicy: { limit: 1, windowMs: 60_000 } }),
    'workers',
  )

  const makeRequest = () =>
    app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': '203.0.113.10',
      },
      body: JSON.stringify({ username: 'someone@example.com', password: 'x' }),
    })

  const first = await makeRequest()
  // No DB configured -> invalid credentials (401), but not rate-limited yet.
  assertEquals(first.status, 401)

  const second = await makeRequest()
  assertEquals(second.status, 429)
  assertEquals(second.headers.get('Retry-After') !== null, true)
})

it('spoofed X-Real-IP / X-Forwarded-For cannot bypass Workers rate limits', async () => {
  const app = await buildApp(
    createAuthRateLimiter({ defaultPolicy: { limit: 1, windowMs: 60_000 } }),
    'workers',
  )

  const makeRequest = (headers: Record<string, string>) =>
    app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'someone@example.com', password: 'x' }),
    })

  assertEquals(
    (await makeRequest({ 'CF-Connecting-IP': '203.0.113.20' })).status,
    401,
  )
  // Rotating spoofed forwarding headers while keeping the trusted CF IP must
  // still hit the shared identity (and IP) buckets.
  assertEquals(
    (
      await makeRequest({
        'CF-Connecting-IP': '203.0.113.20',
        'X-Real-IP': '198.51.100.1',
        'X-Forwarded-For': '198.51.100.2',
      })
    ).status,
    429,
  )
})

it('Workers auth fails closed when no durable limiter is injected', async () => {
  // No limiter in context -> Workers must not silently fall back to a
  // per-isolate limiter. The very first attempt is rejected (fail closed).
  const app = await buildApp(undefined, 'workers')

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '203.0.113.99',
    },
    body: JSON.stringify({ username: 'someone@example.com', password: 'x' }),
  })
  assertEquals(res.status, 429)
  assertEquals(res.headers.get('Retry-After') !== null, true)
})

it('same-account attempts from different IPs cannot bypass the account cap', async () => {
  const app = await buildApp(
    createAuthRateLimiter({ defaultPolicy: { limit: 1, windowMs: 60_000 } }),
    'workers',
  )

  const makeRequest = (ip: string) =>
    app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': ip,
      },
      body: JSON.stringify({ username: 'someone@example.com', password: 'x' }),
    })

  assertEquals((await makeRequest('203.0.113.20')).status, 401)
  // Different IP, same identity -> still blocked (identity bucket).
  assertEquals((await makeRequest('203.0.113.21')).status, 429)
})

it('Deno createApp injects authRateLimiter before client routes (deny-all → 429)', async () => {
  // Regression: Deno previously set authRateLimiter *after* registerClientRoutes,
  // so client auth fell through to getSharedAuthRateLimiter(). A deny-all limiter
  // passed to createApp must be the one auth routes use.
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  const app = createApp({
    secrets,
    otpVerifierSecrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    authRateLimiter: createFailClosedAuthRateLimiter(),
  })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.77',
      Origin: 'http://localhost',
    },
    body: JSON.stringify({ username: 'someone@example.com', password: 'x' }),
  })
  assertEquals(res.status, 429)
  assertEquals(res.headers.get('Retry-After') !== null, true)
})

it('Deno auth stays throttled when Redis-backed limiter fails closed', async () => {
  // Mirrors deno.ts wiring: durable auth limiter over Redis with onError:'closed'.
  // When Redis eval throws, every check must deny (429) — never fail open.
  const badClient = {
    eval: () => Promise.reject(new Error('redis down')),
  } as unknown as RedisCellClient

  const authRateLimiter = createDurableAuthRateLimiter(
    createRedisRateLimiter({
      client: badClient,
      limit: 10,
      periodSeconds: 60,
      onError: 'closed',
    }),
  )

  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  const app = createApp({
    secrets,
    otpVerifierSecrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    authRateLimiter,
  })

  const res = await app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Real-IP': '203.0.113.88',
      Origin: 'http://localhost',
    },
    body: JSON.stringify({ username: 'someone@example.com', password: 'x' }),
  })
  assertEquals(res.status, 429)
  assertEquals(res.headers.get('Retry-After') !== null, true)
})
