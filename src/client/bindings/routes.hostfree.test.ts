/**
 * Host-free coverage for binding route short-circuits (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { registerBindingRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerBindingRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return app
}

test('registerBindingRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerBindingRoutes(app, { runtime: 'deno', signupEnvOverride: undefined })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

test('GET /bindings returns 401 without a session cookie', async () => {
  const app = await buildApp(undefined)
  const res = await app.request('/bindings?serviceId=11111111-1111-4111-8111-111111111111')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('GET /bindings returns 401 when db is set but session is missing', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request('/bindings?serviceId=11111111-1111-4111-8111-111111111111')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('POST /bindings returns 401 without a session', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request('/bindings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      principalId: '11111111-1111-4111-8111-111111111111',
      serviceId: '22222222-2222-4222-8222-222222222222',
      databaseName: 'postgres',
    }),
  })
  assertEquals(res.status, 401)
})

test('PATCH /bindings/:id returns 401 without a session', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request(
    '/bindings/11111111-1111-4111-8111-111111111111',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyPrefix: 'APP' }),
    },
  )
  assertEquals(res.status, 401)
})

test('DELETE /bindings/:id returns 401 without a session', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request(
    '/bindings/11111111-1111-4111-8111-111111111111',
    { method: 'DELETE' },
  )
  assertEquals(res.status, 401)
})
