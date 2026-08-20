/**
 * Host-free coverage for hosting route short-circuits (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { registerHostingRoutes } from './routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerHostingRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

test('registerHostingRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerHostingRoutes(app, { runtime: 'deno', signupEnvOverride: undefined })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

test('GET /hostings returns 401 without a session cookie', async () => {
  const app = await buildApp(undefined)
  const res = await app.request('/hostings')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('GET /hostings returns 401 when db is set but session is missing', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request('/hostings')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('POST /hostings returns 401 without a session', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request('/hostings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Site' }),
  })
  assertEquals(res.status, 401)
})
