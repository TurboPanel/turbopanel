/**
 * The self-hosted tunnel-token route keeps its behaviour after moving behind
 * the `registerPlatformAdminRoutes` hook.
 */
import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { ADMIN_API_PREFIX } from '../../../app/surfaces.ts'
import { registerAdminRoutes } from '../../../admin/routes.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from '../../../client/authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../../../client/authn/crypto.ts'
import type { DaemonCellRegistry } from '../../../contracts/cell.ts'
import { deriveSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import { registerIngressAdminRoutes } from './admin-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const EMPTY_REGISTRY = {
  listOnlineServerIds: () => Promise.resolve([]),
  getSnapshots: () => Promise.resolve(new Map()),
} as unknown as DaemonCellRegistry

async function buildApp(role: 'admin' | 'superadmin') {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `ingress-${crypto.randomUUID()}@example.com`,
    role,
  })
  const db = createMockAuthDb(state)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', EMPTY_REGISTRY)
    return next()
  })
  registerAdminRoutes(app, {
    secrets,
    runtime: 'deno',
    devSurface: false,
    collectInstanceIps: () => [],
    registerPlatformAdminRoutes: registerIngressAdminRoutes,
  })
  return { app, cookie }
}

function postToken(app: Hono<AppEnv>, cookie: string, body: string) {
  return app.request(`${ADMIN_API_PREFIX}/instance/tunnel-token`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body,
  })
}

test('tunnel-token refuses an organization admin with a clean 403', async () => {
  const { app, cookie } = await buildApp('admin')
  const res = await postToken(app, cookie, JSON.stringify({ token: 'x' }))
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})

test('tunnel-token answers 400 on a bad body for a superadmin', async () => {
  const { app, cookie } = await buildApp('superadmin')
  const res = await postToken(app, cookie, JSON.stringify({ nope: 1 }))
  assertEquals(res.status, 400)
})

test('tunnel-token answers 503 when no co-located daemon is connected', async () => {
  const { app, cookie } = await buildApp('superadmin')
  const res = await postToken(app, cookie, JSON.stringify({ token: '' }))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), {
    ok: false,
    error: 'no co-located daemon connected to run the tunnel',
  })
})

function call(app: Hono<AppEnv>, cookie: string, method: string, path: string, body?: unknown) {
  return app.request(`${ADMIN_API_PREFIX}${path}`, {
    method,
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('every ingress change is refused to an organization admin', async () => {
  const { app, cookie } = await buildApp('admin')
  const writes: [string, string][] = [
    ['POST', '/instance/ingress/accounts'],
    ['DELETE', '/instance/ingress/accounts/x'],
    ['POST', '/instance/ingress/accounts/x/recheck'],
    ['PUT', '/instance/ingress/gate'],
    ['PATCH', '/instance/ingress/hostnames/x'],
    ['POST', '/instance/ingress/hostnames/x/preflight'],
    ['POST', '/instance/ingress/hostnames/x/apply'],
    ['POST', '/instance/ingress/hostnames/x/remove'],
    ['POST', '/instance/acme-dns/hostnames/x/order'],
    ['POST', '/instance/acme-dns/hostnames/x/retry'],
    ['POST', '/instance/ingress/tunnel/refresh'],
  ]
  for (const [method, path] of writes) {
    const res = await call(app, cookie, method, path, {})
    assertEquals(res.status, 403, `${method} ${path}`)
    await res.body?.cancel()
  }
})

test('account and gate writes check the body before anything else', async () => {
  const { app, cookie } = await buildApp('superadmin')
  const account = await call(app, cookie, 'POST', '/instance/ingress/accounts', { label: 'x' })
  assertEquals(account.status, 400)
  const bunny = await call(app, cookie, 'POST', '/instance/ingress/accounts', {
    provider: 'bunny',
    label: 'x',
    token: 'y',
  })
  assertEquals(bunny.status, 400)
  const gate = await call(app, cookie, 'PUT', '/instance/ingress/gate', { confirmed: 'yes' })
  assertEquals(gate.status, 400)
})

test('ingress reads answer 503 until data encryption is ready, never 500', async () => {
  const { app, cookie } = await buildApp('superadmin')
  for (const path of [
    '/instance/ingress/capabilities',
    '/instance/ingress/accounts',
    '/instance/ingress/hostnames/x/status',
    '/instance/acme-dns/hostnames/x',
    '/instance/ingress/tunnel',
  ]) {
    const res = await call(app, cookie, 'GET', path)
    assertEquals(res.status, 503, path)
    await res.body?.cancel()
  }
})
