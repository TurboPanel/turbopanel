/**
 * Host-free coverage for managed route short-circuits (no Postgres).
 */

import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { managedSessionPaths } from './routes-helpers.ts'
import { registerManagedRoutes } from './routes.ts'

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
  registerManagedRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

test('registerManagedRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerManagedRoutes(app, {
      runtime: 'deno',
      signupEnvOverride: undefined,
    })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

test('managed session paths return 401 without a session cookie', async () => {
  const app = await buildApp(undefined)
  for (const path of managedSessionPaths()) {
    const concrete = path
      .replaceAll(':id', '11111111-1111-4111-8111-111111111111')
      .replaceAll(':principalId', '22222222-2222-4222-8222-222222222222')
      .replaceAll(':databaseName', 'appdb')
      .replaceAll(':backupId', 'backup-1')
      .replaceAll(':memberId', '33333333-3333-4333-8333-333333333333')
    const res = await app.request(concrete, { method: 'GET' })
    assertEquals(res.status, 401, path)
  }
})

test('POST create managed returns 401 when db is set but session missing', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request(
    '/environments/11111111-1111-4111-8111-111111111111/managed',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  )
  assertEquals(res.status, 401)
})

test('GET org managed returns 401 without session', async () => {
  const app = await buildApp({} as Db)
  const res = await app.request(
    '/organizations/11111111-1111-4111-8111-111111111111/managed',
  )
  assertEquals(res.status, 401)
})
