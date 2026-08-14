/**
 * Host-free coverage for service route authz short-circuits (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { registerServiceRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const serviceId = '11111111-1111-4111-8111-111111111111'

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerServiceRoutes(app, { secrets, runtime: 'deno' })
  return app
}

test('service routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  const paths = [
    ['GET', '/services'],
    ['POST', '/services'],
    ['GET', `/services/${serviceId}`],
    ['PATCH', `/services/${serviceId}`],
    ['DELETE', `/services/${serviceId}`],
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
