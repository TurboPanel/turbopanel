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

/** `update(server).set(values).where(...).returning(...)`: records `values`, matches one row. */
function fakeServerUpdate(updates: Record<string, unknown>[]) {
  const returning = () => Promise.resolve([{ id: 'srv-1' }])
  return {
    set: (values: Record<string, unknown>) => {
      updates.push(values)
      return { where: () => ({ returning }) }
    },
  }
}

/** `select().from(server)`, awaited whole or narrowed with `.where().limit()`. */
function fakeServerSelect(rows: Record<string, unknown>[]) {
  const first = () => Promise.resolve(rows.slice(0, 1))
  return Object.assign(Promise.resolve(rows), { where: () => ({ limit: first }) })
}

async function buildApp(opts: {
  role?: string
  runtime?: 'deno' | 'workers'
  createdAt?: string
  configured?: boolean
  serverRows?: Record<string, unknown>[]
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
  const serverRows = opts.serverRows ?? [{ id: 'srv-1', name: 'alpha', organizationId: 'org-1' }]
  const serverUpdates: Record<string, unknown>[] = []
  // The mock auth database has no server table; answer its reads and record
  // its updates. A filtered read returns the first row.
  const db = new Proxy(baseDb, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return (table: unknown) =>
          table === server ? fakeServerUpdate(serverUpdates) : target.update(table as never)
      }
      if (prop !== 'select') return Reflect.get(target, prop, receiver)
      return (fields?: unknown) => ({
        from: (table: unknown) =>
          table === server
            ? fakeServerSelect(serverRows)
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
  return { app, cookie, identity, serverUpdates }
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

const SEALED_URL = `${IDENTITY_URL}/sealed-secrets`
const KID = 'K'.repeat(43)

function sealingRow(id: string, overrides: Record<string, unknown>) {
  return {
    id,
    name: id,
    hostname: null,
    organizationId: 'org-1',
    isConnected: true,
    daemon: { projection: { features: ['daemon-sealed-secrets-v1'] } },
    sealingKeyKid: KID,
    sealingKeyPub: 'P'.repeat(43),
    sealingKeyReportedAt: '2026-11-01T00:00:00.000Z',
    plaintextSecretsAt: null,
    ...overrides,
  }
}

test('the sealed-secrets read lists which servers still get plaintext', async () => {
  const { app, cookie } = await buildApp({
    serverRows: [
      sealingRow('sealed', {}),
      sealingRow('legacy', {
        daemon: { projection: { features: [] } },
        sealingKeyKid: null,
        sealingKeyPub: null,
        sealingKeyReportedAt: null,
        plaintextSecretsAt: '2026-11-01T01:00:00.000Z',
      }),
      sealingRow('no-key', { sealingKeyKid: null, sealingKeyPub: null }),
      // A hello that leaves the feature out does not switch sealing off.
      sealingRow('stripped-hello', { daemon: { projection: { features: [] } } }),
    ],
  })
  const res = await app.request(SEALED_URL, { headers: { Cookie: cookie } })
  assertEquals(res.status, 200)
  const text = await res.text()
  assert(!text.includes('P'.repeat(43)), 'the public key itself is not repeated')
  const body = JSON.parse(text)
  assertEquals(body.receivingPlaintext, 2)
  assertEquals(body.servers[0], {
    id: 'sealed',
    name: 'sealed',
    hostname: null,
    organizationId: 'org-1',
    isConnected: true,
    advertisesSealedSecrets: true,
    sealingKey: { kid: KID, reportedAt: '2026-11-01T00:00:00.000Z' },
    plaintextSecretsAt: null,
    receivesPlaintext: false,
  })
  assertEquals(body.servers[1].advertisesSealedSecrets, false)
  assertEquals(body.servers[1].sealingKey, null)
  assertEquals(body.servers[1].plaintextSecretsAt, '2026-11-01T01:00:00.000Z')
  assertEquals(body.servers[1].receivesPlaintext, true)
  assertEquals(body.servers[2].advertisesSealedSecrets, true)
  assertEquals(body.servers[2].receivesPlaintext, true)
  assertEquals(body.servers[3].advertisesSealedSecrets, false)
  assertEquals(body.servers[3].receivesPlaintext, false)
})

test('the sealed-secrets read is refused for a non-superadmin', async () => {
  const { app, cookie } = await buildApp({ role: 'admin', serverRows: [] })
  assertEquals((await app.request(SEALED_URL, { headers: { Cookie: cookie } })).status, 403)
  assertEquals((await app.request(SEALED_URL)).status, 401)
})

const CLEAR_SERVER_ID = '0190a5b6-7c8d-7e9f-8a0b-1c2d3e4f5a6b'
const CLEAR_URL = `${SEALED_URL}/${CLEAR_SERVER_ID}/key`

function clearKey(app: Hono<AppEnv>, cookie: string, confirmName?: string) {
  const query = confirmName === undefined ? '' : `?confirmName=${encodeURIComponent(confirmName)}`
  return app.request(`${CLEAR_URL}${query}`, { method: 'DELETE', headers: { Cookie: cookie } })
}

function rolledBackRow(overrides: Record<string, unknown> = {}) {
  // A rolled-back daemon's hello no longer lists sealed secrets.
  return sealingRow(CLEAR_SERVER_ID, {
    name: 'alpha',
    hostname: 'alpha.example.com',
    daemon: { projection: { features: [] } },
    ...overrides,
  })
}

test('clearing a sealing key wipes the three columns once the name is typed', async () => {
  const { app, cookie, serverUpdates } = await buildApp({ serverRows: [rolledBackRow()] })
  const res = await clearKey(app, cookie, 'alpha')
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true, cleared: true })
  assertEquals(serverUpdates.length, 1)
  const [update] = serverUpdates
  assertEquals(update?.sealingKeyKid, null)
  assertEquals(update?.sealingKeyPub, null)
  assertEquals(update?.sealingKeyReportedAt, null)
})

test('clearing a sealing key is refused for a non-superadmin', async () => {
  const { app, cookie, serverUpdates } = await buildApp({
    role: 'admin',
    serverRows: [rolledBackRow()],
  })
  assertEquals((await clearKey(app, cookie, 'alpha')).status, 403)
  assertEquals(serverUpdates.length, 0)
})

test('clearing a sealing key needs the exact server name', async () => {
  const { app, cookie, serverUpdates } = await buildApp({ serverRows: [rolledBackRow()] })
  for (const typed of [undefined, '', 'Alpha', ' alpha', 'alpha.example.com']) {
    const res = await clearKey(app, cookie, typed)
    assertEquals(res.status, 400, String(typed))
    const body = await res.json()
    assertEquals(body.error, 'confirm_name_required')
    assertEquals(body.message, 'Type the server name to clear its sealing key.')
  }
  assertEquals(serverUpdates.length, 0)
})

test('a server without a name is confirmed by its hostname', async () => {
  const { app, cookie } = await buildApp({ serverRows: [rolledBackRow({ name: null })] })
  assertEquals((await clearKey(app, cookie, 'alpha.example.com')).status, 200)
})

test('clearing is refused while a connected daemon opens sealed secrets', async () => {
  const { app, cookie, serverUpdates } = await buildApp({
    serverRows: [
      rolledBackRow({ daemon: { projection: { features: ['daemon-sealed-secrets-v1'] } } }),
    ],
  })
  const res = await clearKey(app, cookie, 'alpha')
  assertEquals(res.status, 409)
  assertEquals((await res.json()).error, 'daemon_seals_secrets')
  assertEquals(serverUpdates.length, 0)
})

test('an offline server can be cleared whatever its last hello said', async () => {
  const { app, cookie } = await buildApp({
    serverRows: [
      rolledBackRow({
        isConnected: false,
        daemon: { projection: { features: ['daemon-sealed-secrets-v1'] } },
      }),
    ],
  })
  assertEquals((await clearKey(app, cookie, 'alpha')).status, 200)
})

test('a server with no key on file changes nothing', async () => {
  const { app, cookie, serverUpdates } = await buildApp({
    serverRows: [rolledBackRow({ sealingKeyKid: null, sealingKeyPub: null })],
  })
  const res = await clearKey(app, cookie, 'alpha')
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ok: true, cleared: false })
  assertEquals(serverUpdates.length, 0)
})

test('an unknown server is 404', async () => {
  const { app, cookie } = await buildApp({ serverRows: [] })
  assertEquals((await clearKey(app, cookie, 'alpha')).status, 404)
})

test('a server id that is not a uuid is 404 before any read', async () => {
  const { app, cookie, serverUpdates } = await buildApp({ serverRows: [rolledBackRow()] })
  const res = await app.request(`${SEALED_URL}/srv-1/key?confirmName=alpha`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 404)
  assertEquals(serverUpdates.length, 0)
})

test('clearing a sealing key asks a stale session to re-authenticate first', async () => {
  const { app, cookie, serverUpdates } = await buildApp({
    createdAt: STALE,
    serverRows: [rolledBackRow()],
  })
  const res = await clearKey(app, cookie, 'alpha')
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.error, 'reauth_required')
  assertEquals(body.action, 'server.sealing_key.clear')
  assertEquals(serverUpdates.length, 0)
})
