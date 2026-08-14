/**
 * Host-free coverage for IP route authz short-circuits (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { registerIpRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const id = '11111111-1111-4111-8111-111111111111'

async function buildApp(): Promise<Hono<AppEnv>> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerIpRoutes(app, { secrets, runtime: 'deno' })
  return app
}

test('ip routes return 401 without a session cookie', async () => {
  const app = await buildApp()
  const paths = [
    ['GET', '/ips'],
    ['POST', '/ips'],
    ['GET', `/ips/${id}`],
    ['PATCH', `/ips/${id}`],
    ['DELETE', `/ips/${id}`],
  ] as const
  for (const [method, path] of paths) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({ address: '203.0.113.10', scope: 'public' }),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})
