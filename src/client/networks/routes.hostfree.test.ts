/**
 * Host-free coverage for network route authz short-circuits (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { registerNetworkRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const id = '11111111-1111-4111-8111-111111111111'

async function buildApp(): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerNetworkRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

test('network routes return 401 without a session cookie', async () => {
  const app = await buildApp()
  const paths = [
    ['GET', '/networks'],
    ['POST', '/networks'],
    ['GET', `/networks/${id}`],
    ['PATCH', `/networks/${id}`],
    ['DELETE', `/networks/${id}`],
  ] as const
  for (const [method, path] of paths) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({ kind: 'docker', name: 'net' }),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})
