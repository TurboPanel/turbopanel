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

const storageId = '11111111-1111-4111-8111-111111111111'
const locationId = '22222222-2222-4222-8222-222222222222'
const mountId = '33333333-3333-4333-8333-333333333333'

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

test('storage routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  const paths = [
    ['GET', '/storage'],
    ['POST', '/storage'],
    ['GET', `/storage/${storageId}`],
    ['PATCH', `/storage/${storageId}`],
    ['DELETE', `/storage/${storageId}`],
    ['GET', `/storage/${storageId}/locations`],
    ['POST', `/storage/${storageId}/locations`],
    ['PATCH', `/storage/${storageId}/locations/${locationId}`],
    ['DELETE', `/storage/${storageId}/locations/${locationId}`],
    ['GET', `/storage/${storageId}/mounts`],
    ['POST', `/storage/${storageId}/mounts`],
    ['PATCH', `/storage/${storageId}/mounts/${mountId}`],
    ['DELETE', `/storage/${storageId}/mounts/${mountId}`],
  ] as const

  for (const [method, path] of paths) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({}),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('GET /storage returns 401 when db is missing', async () => {
  const app = await buildApp(undefined)
  const res = await app.request('/storage')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})
