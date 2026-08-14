/**
 * Host-free coverage for install route short-circuits (no Postgres / PAM).
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockInstalledInstance,
} from '../../client/authn/authn-hostfree-doubles.ts'
import { createAuthRateLimiter } from '../../client/authn/auth-rate-limit.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../../client/authn/secrets.ts'
import { INSTALL_API_PREFIX } from '../../surfaces.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { registerInstallRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function buildApp(opts: {
  runtime?: 'deno' | 'workers'
  withSecrets?: boolean
  withDb?: boolean
  installed?: boolean
} = {}): Promise<Hono<AppEnv>> {
  const runtime = opts.runtime ?? 'deno'
  const withSecrets = opts.withSecrets ?? true
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, runtime)
  const secrets = withSecrets
    ? await deriveSecretsConfig(secretsConfig, 'session-signing')
    : undefined

  const state = createEmptyMockAuthState()
  if (opts.installed) seedMockInstalledInstance(state)
  const db = opts.withDb === false ? undefined : createMockAuthDb(state)

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    c.set('authRateLimiter', createAuthRateLimiter({
      defaultPolicy: { limit: 10_000, windowMs: 60_000 },
    }))
    return next()
  })
  registerInstallRoutes(app, { secrets, runtime })
  return app
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

test('POST / returns 400 for incomplete install bodies', async () => {
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
