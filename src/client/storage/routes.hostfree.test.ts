/**
 * Host-free coverage for storage route short-circuits (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { registerStorageRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'

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
  registerStorageRoutes(app, { secrets, runtime: 'deno' })
  return app
}

test('GET /storage returns 401 without a session cookie', async () => {
  const app = await buildApp(undefined)
  const res = await app.request('/storage')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('GET /storage returns 401 when db is set but session is missing', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request('/storage')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('POST /storage returns 401 without a session cookie', async () => {
  const app = await buildApp(undefined)
  const res = await app.request('/storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 401)
})
