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

test('porcelainPath trims a rename target with extra spaces', () => {
  assertEquals(porcelainPath('R  old.ts ->  new.ts  '), 'new.ts')
})

test('isRuntimePorcelainLine matches a rename into a runtime tree', () => {
  assertEquals(isRuntimePorcelainLine('R  tmp.log -> .local/console.log'), true)
  assertEquals(isRuntimePorcelainLine('?? src/.local-not-runtime.ts'), false)
})

test('registerSystemRoutes requires developer auth by default', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  registerSystemRoutes(app, { secrets })
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
  )
  assertEquals(response.status, 401)
})

test('POST /system/upgrade is refused when dirty, git fails, or restart is unset', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  registerSystemRoutes(app, { secrets, authRequired: false })
  const response = await app.request(`${DEVELOPER_API_PREFIX}/system/upgrade`, {
    method: 'POST',
  })
  assertEquals([409, 500, 503].includes(response.status), true)
  const body = await response.json()
  if (typeof body !== 'object' || body === null || !('ok' in body)) {
    throw new TypeError('upgrade response must be an object with ok')
  }
  assertEquals(body.ok, false)
})

test('GET /system/upgrade-status reports canUpgrade or a git error', async () => {
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'session-signing',
  )
  const app = new Hono()
  registerSystemRoutes(app, { secrets, authRequired: false })
  const response = await app.request(
    `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
  )
  const body = await response.json()
  if (typeof body !== 'object' || body === null || !('ok' in body)) {
    throw new TypeError('upgrade-status response must be an object with ok')
  }
  if (response.status === 200) {
    assertEquals(body.ok, true)
    if (!('canUpgrade' in body) || !('dirty' in body)) {
      throw new TypeError('successful upgrade-status must include canUpgrade and dirty')
    }
    assertEquals(typeof body.canUpgrade, 'boolean')
    assertEquals(Array.isArray(body.dirty), true)
    return
  }
  assertEquals(response.status, 500)
  assertEquals(body.ok, false)
})

test('GET /system/upgrade-status fails when TURBOPANEL_UI_REPO is not a checkout', async () => {
  const previous = Deno.env.get('TURBOPANEL_UI_REPO')
  Deno.env.set('TURBOPANEL_UI_REPO', '/tmp/turbopanel-missing-ui-checkout')
  try {
    const secrets = await deriveSecretsConfig(
      parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
      'session-signing',
    )
    const app = new Hono()
    registerSystemRoutes(app, { secrets, authRequired: false })
    const response = await app.request(
      `${DEVELOPER_API_PREFIX}/system/upgrade-status`,
    )
    assertEquals(response.status, 500)
    const body = await response.json()
    if (typeof body !== 'object' || body === null || !('ok' in body) || !('error' in body)) {
      throw new TypeError('failed upgrade-status must include ok and error')
    }
    assertEquals(body.ok, false)
    assertEquals(typeof body.error, 'string')
  } finally {
    if (previous === undefined) Deno.env.delete('TURBOPANEL_UI_REPO')
    else Deno.env.set('TURBOPANEL_UI_REPO', previous)
  }
})

test('porcelainPath keeps a path that is not a rename', () => {
  assertEquals(porcelainPath('?? path with spaces.ts'), 'path with spaces.ts')
  assertEquals(porcelainPath('D  gone.ts'), 'gone.ts')
})

test('isRuntimePorcelainLine matches every runtime prefix', () => {
  assertEquals(isRuntimePorcelainLine('?? .config/foo'), true)
  assertEquals(isRuntimePorcelainLine('?? .cache/bar'), true)
  assertEquals(isRuntimePorcelainLine(' M .local/nested/x'), true)
})
