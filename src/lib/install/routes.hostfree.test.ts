/**
 * Host-free coverage for install route short-circuits (no Postgres / PAM).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockInstalledInstance,
} from '../../client/authn/authn-hostfree-doubles.ts'
import {
  createAuthRateLimiter,
  createFailClosedAuthRateLimiter,
  type AuthRateLimiter,
} from '../../client/authn/auth-rate-limit.ts'
import { deriveSecretsConfig } from '../../client/authn/secrets.ts'
import { INSTALL_API_PREFIX } from '../../surfaces.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerInstallRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/**
 * Install host-auth bypass without `Deno.env.set` (no `--allow-env` needed).
 * Production reads `TURBOPANEL_DEV_HOST_AUTH` + explicit-dev via `Deno.env.get`.
 */
async function withDevHostAuth(
  fn: () => void | Promise<void>,
): Promise<void> {
  const env = Deno.env
  const originalGet = env.get.bind(env)
  const patchedGet = (key: string): string | undefined => {
    if (key === 'TURBOPANEL_DEV_HOST_AUTH') return 'group-only'
    if (key === 'TURBOPANEL_DEV_SURFACE') return '1'
    if (key === 'TURBOPANEL_MODE' || key === 'TURBOPANEL_UI_MODE') {
      return undefined
    }
    try {
      return originalGet(key)
    } catch {
      return undefined
    }
  }

  Object.defineProperty(env, 'get', {
    configurable: true,
    writable: true,
    value: patchedGet,
  })
  try {
    await fn()
  } finally {
    Object.defineProperty(env, 'get', {
      configurable: true,
      writable: true,
      value: originalGet,
    })
  }
}

async function buildApp(opts: {
  runtime?: 'deno' | 'workers'
  withSecrets?: boolean
  withDb?: boolean
  installed?: boolean
  authRateLimiter?: AuthRateLimiter
} = {}): Promise<Hono<AppEnv>> {
  const runtime = opts.runtime ?? 'deno'
  const withSecrets = opts.withSecrets ?? true
  const secretsConfig = parseTestSecretsConfig(runtime)
  const secrets = withSecrets
    ? await deriveSecretsConfig(secretsConfig, 'session-signing')
    : undefined

  const state = createEmptyMockAuthState()
  if (opts.installed) seedMockInstalledInstance(state)
  const db = opts.withDb === false ? undefined : createMockAuthDb(state)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    c.set(
      'authRateLimiter',
      opts.authRateLimiter ?? createAuthRateLimiter({
        defaultPolicy: { limit: 10_000, windowMs: 60_000 },
      }),
    )
    return next()
  })
  registerInstallRoutes(app, { secrets, runtime, signupEnvOverride: undefined })
  return app
}

function completeInstallBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    username: 'root',
    password: 'host-secret',
    superadminEmail: 'admin@203.0.113.10.example',
    superadminPassword: 'sup3r-secret!',
    ...overrides,
  })
}

test('POST /bootstrap returns 404 on Workers runtime', async () => {
  const app = await buildApp({ runtime: 'workers' })
  const res = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'x' }),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { ok: false, error: 'Not available' })
})

test('POST /bootstrap returns 503 without a database', async () => {
  const app = await buildApp({ withDb: false })
  const res = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'x' }),
  })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { ok: false, error: 'Database unavailable' })
})

test('POST /bootstrap returns 409 when the instance is already configured', async () => {
  const app = await buildApp({ installed: true })
  const res = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'x' }),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    ok: false,
    error: 'Instance is already configured',
  })
})

test('POST /bootstrap returns 400 for invalid JSON and bodies', async () => {
  const app = await buildApp()
  const badJson = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assertEquals(badJson.status, 400)
  assertEquals(await badJson.json(), { ok: false, error: 'Invalid request' })

  const missingPassword = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root' }),
  })
  assertEquals(missingPassword.status, 400)
  assertEquals(await missingPassword.json(), {
    ok: false,
    error: 'Invalid request',
  })
})

test('POST /bootstrap returns 401 for invalid host credentials without PAM', async () => {
  const app = await buildApp()
  // Space fails HOST_USERNAME_RE after body parse — no PAM spawn.
  const res = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bad user', password: 'secret' }),
  })
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Invalid credentials' })
})

test('POST / returns 404 on Workers runtime', async () => {
  const app = await buildApp({ runtime: 'workers' })
  const res = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: 'x',
      superadminEmail: 'admin@203.0.113.10.example',
      superadminPassword: 'Sup3r-secret!',
    }),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { ok: false, error: 'Not available' })
})

test('POST / returns 503 without session secrets', async () => {
  const app = await buildApp({ withSecrets: false })
  const res = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: 'x',
      superadminEmail: 'admin@203.0.113.10.example',
      superadminPassword: 'Sup3r-secret!',
    }),
  })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { ok: false, error: 'Not configured' })
})

test('POST / returns 503 without a database', async () => {
  const app = await buildApp({ withDb: false })
  const res = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: 'x',
      superadminEmail: 'admin@203.0.113.10.example',
      superadminPassword: 'Sup3r-secret!',
    }),
  })
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { ok: false, error: 'Database unavailable' })
})

test('POST / returns 409 when the instance is already configured', async () => {
  const app = await buildApp({ installed: true })
  const res = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: 'x',
      superadminEmail: 'admin@203.0.113.10.example',
      superadminPassword: 'Sup3r-secret!',
    }),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), {
    ok: false,
    error: 'Instance is already configured',
  })
})

test('POST / returns 400 for incomplete install bodies and invalid JSON', async () => {
  const app = await buildApp()
  const res = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'root',
      password: 'x',
      superadminEmail: 'admin@203.0.113.10.example',
    }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { ok: false, error: 'Invalid request' })

  const badJson = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assertEquals(badJson.status, 400)
  assertEquals(await badJson.json(), { ok: false, error: 'Invalid request' })
})

test('POST / returns 401 for invalid host credentials without PAM', async () => {
  const app = await buildApp()
  const res = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'bad user',
      password: 'secret',
      superadminEmail: 'admin@203.0.113.10.example',
      superadminPassword: 'Sup3r-secret!',
    }),
  })
  assertEquals(res.status, 401)
  assertEquals(await res.json(), {
    ok: false,
    error: 'Invalid host credentials',
  })
})

test('POST /bootstrap and POST / return 429 when the limiter blocks', async () => {
  const app = await buildApp({
    authRateLimiter: createFailClosedAuthRateLimiter(),
  })

  const bootstrap = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'x' }),
  })
  assertEquals(bootstrap.status, 429)

  const complete = await app.request(`${INSTALL_API_PREFIX}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: completeInstallBody(),
  })
  assertEquals(complete.status, 429)
})

test('POST /bootstrap returns ok when explicit-dev host auth accepts root', async () => {
  await withDevHostAuth(async () => {
    const app = await buildApp()
    const res = await app.request(`${INSTALL_API_PREFIX}/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'any-nonempty' }),
    })
    assertEquals(res.status, 200)
    assertEquals(await res.json(), { ok: true })
  })
})

test('POST / surfaces completeInstanceInstall validation errors after host auth', async () => {
  await withDevHostAuth(async () => {
    const app = await buildApp()

    const badEmail = await app.request(`${INSTALL_API_PREFIX}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: completeInstallBody({ superadminEmail: 'not-an-email' }),
    })
    assertEquals(badEmail.status, 400)
    assertEquals(await badEmail.json(), {
      ok: false,
      error: 'Enter a valid email address',
    })

    const badPassword = await app.request(`${INSTALL_API_PREFIX}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: completeInstallBody({ superadminPassword: 'short1!' }),
    })
    assertEquals(badPassword.status, 400)
    assertEquals(await badPassword.json(), {
      ok: false,
      error: 'Password must be at least 8 characters',
    })

    const mockDbCannotInstall = await app.request(`${INSTALL_API_PREFIX}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: completeInstallBody(),
    })
    assertEquals(mockDbCannotInstall.status, 400)
    const failed = await mockDbCannotInstall.json()
    if (
      typeof failed !== 'object' || failed === null || !('error' in failed) ||
      !('ok' in failed)
    ) {
      throw new TypeError('complete-install error body')
    }
    assertEquals(failed.ok, false)
    assertEquals(typeof failed.error, 'string')
  })
})
