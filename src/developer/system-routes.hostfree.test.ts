import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../test-fixtures/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../client/authn/secrets.ts'
import { DEVELOPER_API_PREFIX } from '../surfaces.ts'
import {
  dirtyUpgradeError,
  isRuntimePorcelainLine,
  porcelainPath,
  registerSystemRoutes,
} from './system-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('porcelainPath reads the path and rename target', () => {
  assertEquals(porcelainPath(' M src/app.ts'), 'src/app.ts')
  assertEquals(porcelainPath('R  old.ts -> new.ts'), 'new.ts')
})

test('isRuntimePorcelainLine ignores checkout-local runtime trees', () => {
  assertEquals(isRuntimePorcelainLine('?? .local/console.log'), true)
  assertEquals(isRuntimePorcelainLine('?? .config/pnpm/store'), true)
  assertEquals(isRuntimePorcelainLine('?? .cache/deno'), true)
  assertEquals(isRuntimePorcelainLine(' M src/developer/routes.ts'), false)
})

test('dirtyUpgradeError names every dirty checkout', () => {
  assertEquals(
    dirtyUpgradeError([
      { repo: 'instance', path: '/tmp/instance', changes: 2 },
      { repo: 'daemon', path: '/tmp/daemon', changes: 1 },
    ]),
    'cannot upgrade: uncommitted changes in instance, daemon (commit or stash first)',
  )
})

test('registerSystemRoutes mounts upgrade-status without auth when disabled', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  registerSystemRoutes(app, { secrets, authRequired: false })
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
  )
  assertEquals(typeof response.status, 'number')
  assertEquals(response.status === 200 || response.status === 500, true)
})
