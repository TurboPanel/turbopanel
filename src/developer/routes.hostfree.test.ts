import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../client/authn/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import { registerDeveloperRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('registerDeveloperRoutes mounts the Workers-safe core plus studio', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  registerDeveloperRoutes(app, { secrets, authRequired: false })
  const response = await app.request(`${DEVELOPER_API_PREFIX}/daemon/events`)
  assertEquals(response.status, 200)
  const body = await response.json() as { events: unknown[] }
  assertEquals(body.events, [])
})
