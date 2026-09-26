/**
 * `/api/client/v1/status` when the database cannot answer (unmigrated,
 * unreachable): a clear 503, never an opaque 500. Host-free.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import type { Db } from '../db/connection.ts'
import { CLIENT_API_PREFIX } from '../app/surfaces.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import { registerClientRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

/** A database whose every query fails the way an unmigrated schema does. */
function missingRelationDb(): Db {
  const fail = () => {
    throw new Error('relation "setting" does not exist')
  }
  return new Proxy({}, { get: () => fail }) as unknown as Db
}

async function statusApp(runtime: 'deno' | 'workers'): Promise<Hono<AppEnv>> {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig(runtime), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', missingRelationDb())
    c.set('platformEnv', {})
    return next()
  })
  registerClientRoutes(app, {
    secrets,
    runtime,
    signupEnvOverride: undefined,
  })
  return app
}

for (const runtime of ['workers', 'deno'] as const) {
  test(`${runtime} status is a 503 database_error when the database query fails`, async () => {
    const res = await (await statusApp(runtime)).request(`${CLIENT_API_PREFIX}/status`)
    assertEquals(res.status, 503)
    assertEquals(await res.json(), {
      ok: false,
      error: 'Database unavailable',
      code: 'database_error',
    })
  })
}
