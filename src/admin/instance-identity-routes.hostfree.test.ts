/**
 * Host-free coverage for the Panel Identity admin routes: the read carries
 * public values only, and the next-key write is superadmin-only, refuses bad
 * input, and asks for step-up before it changes anything.
 */
import { assert, assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { ADMIN_API_PREFIX } from '../app/surfaces.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from '../client/authn/authn-hostfree-doubles.ts'
import type { Db } from '../db/connection.ts'
import { server } from '../db/schema.ts'
import { createAdminAccessMiddleware } from '../client/authn/middleware.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { resolvePanelIdentityFromBinding } from '../lib/panel-identity/identity.ts'
import { deriveSecretsConfig } from '../lib/secrets/secrets.ts'
import {
  FIXTURE_NEXT_FINGERPRINT,
  fixtureBindingJson,
} from '../test-fixtures/panel-identity-fixture.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { registerInstanceIdentityAdminRoutes } from './instance-identity-routes.ts'

const test = Deno.test.bind(Deno)

const IDENTITY_URL = `${ADMIN_API_PREFIX}/instance/identity`
const NEXT_URL = `${IDENTITY_URL}/next`
const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString()

async function buildApp(opts: {
  role?: string
  runtime?: 'deno' | 'workers'
  createdAt?: string
  configured?: boolean
}) {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: 'root@example.com',
    role: opts.role ?? 'superadmin',
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  })
  const baseDb = createMockAuthDb(state)
  // The mock auth database has no server table; answer that one read.
  const db = new Proxy(baseDb, {
    get(target, prop, receiver) {
      if (prop !== 'select') return Reflect.get(target, prop, receiver)
      return (fields?: unknown) => ({
        from: (table: unknown) =>
          table === server
            ? Promise.resolve([{ id: 'srv-1', name: 'alpha', organizationId: 'org-1' }])
            : target.select(fields as never).from(table as never),
      })
    },
  }) as Db
  const identity =
    opts.configured === false
      ? null
      : await resolvePanelIdentityFromBinding(
          await fixtureBindingJson({ next: { kid: FIXTURE_NEXT_FINGERPRINT } })
        )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const admin = new Hono<AppEnv>()
  admin.use('*', createAdminAccessMiddleware(secrets))
  registerInstanceIdentityAdminRoutes(admin, {
    secrets,
    runtime: opts.runtime ?? 'deno',
    panelIdentity: () => Promise.resolve(identity),
    identityUrls: () => Promise.resolve(['https://panel.example.com']),
  })
  app.route(ADMIN_API_PREFIX, admin)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return { app, cookie, identity }
}

function put(app: Hono<AppEnv>, cookie: string, body: unknown) {
  return app.request(NEXT_URL, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('the read returns public fingerprints and no private material', async () => {
  const { app, cookie, identity } = await buildApp({ role: 'admin' })
  const res = await app.request(IDENTITY_URL, { headers: { Cookie: cookie } })
  assertEquals(res.status, 200)
  const text = await res.text()
  const body = JSON.parse(text)
  assertEquals(body.configured, true)
  assertEquals(body.current, { fingerprint: identity?.current.kid, keyset: 1 })
  assertEquals(body.next, { fingerprint: FIXTURE_NEXT_FINGERPRINT })
  assertEquals(body.seal.fingerprint, identity?.seal.kid)
  assertEquals(body.installUrl, 'https://panel.example.com')
  assertEquals(body.servers, [
    { id: 'srv-1', name: 'alpha', organizationId: 'org-1', pinnedBy: 'none' },
  ])
  assert(!/priv|seed|secret/i.test(text), 'no key material in the answer')
})

test('the read says the feature is off when there is no identity', async () => {
  const { app, cookie } = await buildApp({ configured: false })
  const body = await (await app.request(IDENTITY_URL, { headers: { Cookie: cookie } })).json()
  assertEquals(body.configured, false)
  assertEquals(body.current, null)
  assertEquals(body.next, null)
})

test('the read needs an administrator session', async () => {
  const { app, cookie } = await buildApp({ role: 'user' })
  assertEquals((await app.request(IDENTITY_URL)).status, 401)
  assertEquals((await app.request(IDENTITY_URL, { headers: { Cookie: cookie } })).status, 403)
})

test('setting the next key is refused for a non-superadmin', async () => {
  const { app, cookie } = await buildApp({ role: 'admin' })
  assertEquals((await put(app, cookie, { fingerprint: FIXTURE_NEXT_FINGERPRINT })).status, 403)
})

test('a malformed fingerprint is refused before anything changes', async () => {
  const { app, cookie } = await buildApp({})
  for (const fingerprint of ['A'.repeat(42), 'A'.repeat(44), 7, undefined]) {
    assertEquals((await put(app, cookie, { fingerprint })).status, 422, String(fingerprint))
  }
  assertEquals((await put(app, cookie, 'nope')).status, 422)
})

test('a stale session is asked to re-authenticate', async () => {
  const { app, cookie } = await buildApp({ createdAt: STALE })
  const res = await put(app, cookie, { fingerprint: FIXTURE_NEXT_FINGERPRINT })
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.error, 'reauth_required')
  assertEquals(body.action, 'panel.identity_next.set')
})

test('the hosted runtime answers 422: its next key is a binding', async () => {
  const { app, cookie } = await buildApp({ runtime: 'workers' })
  const res = await put(app, cookie, { fingerprint: FIXTURE_NEXT_FINGERPRINT })
  assertEquals(res.status, 422)
  assert((await res.json()).error.includes('TURBOPANEL_IDENTITY_KEYS'))
})
