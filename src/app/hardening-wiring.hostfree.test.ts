/**
 * Road to 0.2.x rows r2-global-body-limit and r2-write-rate-limit: the
 * app-wide body ceiling and the per-session write limiter are mounted in
 * `createApp` itself, not only correct in isolation. A body over the ceiling
 * answers 413 and a refused limiter answers 429, before any route handler.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { createApp } from './app.ts'
import { CLIENT_API_PREFIX } from './surfaces.ts'
import { createBrowserWriteProtectionMiddleware } from './browser-write-protection.ts'
import { REQUEST_BODY_TOO_LARGE_CODE, DEFAULT_REQUEST_BODY_LIMIT_BYTES } from './body-limit.ts'
import { WRITE_RATE_LIMITED_CODE } from './write-rate-limit.ts'
import type { RateLimiter } from '../daemon/rate-limit/contracts.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../lib/secrets/secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORIGIN = 'https://panel.example.com'

async function buildApp(writeRateLimiter?: RateLimiter) {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'workers')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(secretsConfig, 'email-otp-verifier')
  return createApp({
    secrets,
    otpVerifierSecrets,
    runtime: 'workers',
    signupEnvOverride: undefined,
    ...(writeRateLimiter ? { writeRateLimiter } : {}),
  })
}

function post(app: Awaited<ReturnType<typeof buildApp>>, body: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(`${ORIGIN}${CLIENT_API_PREFIX}/servers`, {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'content-type': 'application/json',
          'CF-Connecting-IP': '203.0.113.77',
        },
        body,
      })
    )
  )
}

test('createApp answers 413 to a body over the app-wide ceiling, before any handler', async () => {
  const app = await buildApp()
  const res = await post(app, 'x'.repeat(DEFAULT_REQUEST_BODY_LIMIT_BYTES + 1))
  assertEquals(res.status, 413)
  assertEquals((await res.json()).code, REQUEST_BODY_TOO_LARGE_CODE)
})

test('createApp answers 429 when the injected write limiter refuses', async () => {
  const keys: string[] = []
  const refusing: RateLimiter = {
    limit({ key }) {
      keys.push(key)
      return Promise.resolve({ success: false })
    },
  }
  const app = await buildApp(refusing)
  const res = await post(app, '{}')
  assertEquals(res.status, 429)
  assertEquals((await res.json()).code, WRITE_RATE_LIMITED_CODE)
  assertEquals(keys.length, 1)
})

test('createApp does not rate-limit a write when no limiter is injected', async () => {
  const app = await buildApp()
  const res = await post(app, '{}')
  assertEquals(res.status === 429 || res.status === 413, false)
})

// Path-normalization table: a spelling of a client path that the prefix gates
// do not recognise must also not reach a route handler. A cross-origin write
// with an over-ceiling body and a refusing limiter is stopped by a gate (403,
// 413, 429) or finds no route (404); anything else means a handler ran.
const SPELLINGS = [
  `${CLIENT_API_PREFIX}/servers`,
  `${CLIENT_API_PREFIX}/servers/`,
  `${CLIENT_API_PREFIX}//servers`,
  `/${CLIENT_API_PREFIX}/servers`,
  `${CLIENT_API_PREFIX}/./servers`,
  `${CLIENT_API_PREFIX}/x/../servers`,
  `${CLIENT_API_PREFIX}/%2e/servers`,
  `${CLIENT_API_PREFIX}/%2e%2e/v1/servers`,
  `${CLIENT_API_PREFIX}/servers%2f`,
  `${CLIENT_API_PREFIX.toUpperCase()}/servers`,
  `${CLIENT_API_PREFIX}/servers;x=1`,
  `${CLIENT_API_PREFIX}/servers%00`,
]

test('no spelling of a client path reaches a handler without passing the write gates', async () => {
  const refusing: RateLimiter = { limit: () => Promise.resolve({ success: false }) }
  const app = await buildApp(refusing)
  const answers = await Promise.all(
    SPELLINGS.map(async (path) => {
      const res = await app.request(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            Origin: 'https://attacker.example',
            'content-type': 'application/json',
            'CF-Connecting-IP': '203.0.113.78',
          },
          body: 'x'.repeat(DEFAULT_REQUEST_BODY_LIMIT_BYTES + 1),
        })
      )
      return { path, status: res.status }
    })
  )
  for (const { path, status } of answers) {
    assertEquals([403, 404, 413, 429].includes(status), true, `${path} answered ${status}`)
  }
})

// hono GHSA-h7mg-cq63-vhpq: RegExpRouter skipped wildcard middleware for a
// path holding an encoded line terminator, so the `app.use('*', ...)` gates in
// createApp never ran for it. The browser-write gate must still answer a
// cross-origin write with exactly 403 (not a handler's 401/404/400). createApp's
// large route set may select TrieRouter, which was never affected, so this is
// a wiring guard; the small-app test below is the one that fails on old hono.
const LINE_TERMINATOR_SPELLINGS = [
  `${CLIENT_API_PREFIX}/servers%0A`,
  `${CLIENT_API_PREFIX}/%0Aservers`,
  `${CLIENT_API_PREFIX}/servers%0D`,
  `${CLIENT_API_PREFIX}/servers%E2%80%A8`,
  `${CLIENT_API_PREFIX}/servers%E2%80%A9`,
  `${CLIENT_API_PREFIX}/servers%0A/extra`,
]

test('wildcard write gate runs for a path with an encoded line terminator', async () => {
  const app = await buildApp()
  const answers = await Promise.all(
    LINE_TERMINATOR_SPELLINGS.map(async (path) => {
      const res = await app.request(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            Origin: 'https://attacker.example',
            'content-type': 'application/json',
            'CF-Connecting-IP': '203.0.113.79',
          },
          body: '{}',
        })
      )
      return { path, status: res.status }
    })
  )
  for (const { path, status } of answers) {
    assertEquals(status, 403, `${path} answered ${status}`)
  }
})

// The same gate on a small app with the default router: few static routes keep
// SmartRouter on RegExpRouter, the router the advisory is about. Before hono
// 4.13.16 the gate was skipped for these paths and the request fell through to
// the not-found handler (404) with no middleware run.
test('write gate on a default-router app runs for a path with an encoded line terminator', async () => {
  const app = new Hono()
  app.use('*', createBrowserWriteProtectionMiddleware('workers'))
  app.post(`${CLIENT_API_PREFIX}/servers`, (c) => c.json({ ok: true }))
  for (const path of LINE_TERMINATOR_SPELLINGS) {
    const res = await app.request(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
        body: '{}',
      })
    )
    assertEquals(res.status, 403, `${path} answered ${res.status}`)
  }
})
