import { assertEquals } from '@std/assert'
import { afterEach, it } from '@std/testing/bdd'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { registerAuthRoutes } from './http.ts'
import {
  createAuthRateLimiter,
  setSharedAuthRateLimiterForTests,
} from './auth-rate-limit.ts'

afterEach(() => {
  setSharedAuthRateLimiterForTests(undefined)
})

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const client = new Hono()
  registerAuthRoutes(client, {
    runtime: 'workers',
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return app
}

it('sign-in returns 429 with Retry-After once the limiter blocks', async () => {
  // limit 1 per window: first attempt allowed, second blocked.
  setSharedAuthRateLimiterForTests(
    createAuthRateLimiter({ defaultPolicy: { limit: 1, windowMs: 60_000 } }),
  )
  const app = buildApp()

  const makeRequest = () =>
    app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Real-IP': '203.0.113.10',
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

it('rate-limit keys separate IPs independently', async () => {
  setSharedAuthRateLimiterForTests(
    createAuthRateLimiter({ defaultPolicy: { limit: 1, windowMs: 60_000 } }),
  )
  const app = buildApp()

  const makeRequest = (ip: string) =>
    app.request(`${CLIENT_API_PREFIX}/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Real-IP': ip },
      body: JSON.stringify({ username: 'someone@example.com', password: 'x' }),
    })

  assertEquals((await makeRequest('203.0.113.20')).status, 401)
  // Different IP, same identity -> still allowed (separate bucket).
  assertEquals((await makeRequest('203.0.113.21')).status, 401)
  // First IP again -> blocked.
  assertEquals((await makeRequest('203.0.113.20')).status, 429)
})
