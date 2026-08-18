/**
 * Host-free coverage for organization route create/PATCH/capacity error arms
 * (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { registerOrganizationRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const orgId = '11111111-1111-4111-8111-111111111111'

const ORG_PATHS = [
  ['GET', '/organizations'],
  ['POST', '/organizations'],
  ['GET', `/organizations/${orgId}`],
  ['PATCH', `/organizations/${orgId}`],
  ['GET', `/organizations/${orgId}/default-timezone`],
  ['PUT', `/organizations/${orgId}/default-timezone`],
  ['GET', `/organizations/${orgId}/default-environment`],
  ['PUT', `/organizations/${orgId}/default-environment`],
  ['GET', `/organizations/${orgId}/server-capacity`],
  ['PUT', `/organizations/${orgId}/server-capacity`],
  ['GET', '/timezones'],
] as const

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerOrganizationRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

type SessionAppOpts = {
  manageAllowed: boolean
  ownAllowed?: boolean
  seedOrg?: boolean
  orgOptions?: unknown
  executeQueue?: unknown[][]
}

async function buildSessionApp(
  opts: SessionAppOpts,
): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `org-authz-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `org-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  if (opts.seedOrg !== false) {
    state.organizations.push({ id: orgId, name: 'Org Routes' })
  }

  const executeQueue = [...(opts.executeQueue ?? [])]
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)

  const db = Object.assign(authDb, {
    execute: () => {
      if (executeQueue.length > 0) {
        return Promise.resolve(executeQueue.shift() ?? [])
      }
      // Default: manage checks first, then own when capacity PUT needs it.
      if (opts.ownAllowed === false) {
        return Promise.resolve([{ allowed: false }])
      }
      return Promise.resolve([{ allowed: opts.manageAllowed }])
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === organization && opts.seedOrg !== false) {
          const row = {
            id: orgId,
            name: 'Org Routes',
            displayName: 'Org Routes',
            createdAt: '2020-01-01T00:00:00.000Z',
            options: opts.orgOptions ?? null,
          }
          const rows = [row]
          return Object.assign(Promise.resolve(rows), {
            where: () => ({
              limit: () => Promise.resolve(rows),
              orderBy: () => Promise.resolve(rows),
            }),
            orderBy: () => Promise.resolve(rows),
          })
        }
        if (table === organization && opts.seedOrg === false) {
          return Object.assign(Promise.resolve([]), {
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
            orderBy: () => Promise.resolve([]),
          })
        }
        return origSelect(fields).from(table)
      },
    }),
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerOrganizationRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie }
}

test('organization routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  for (const [method, path] of ORG_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('POST /organizations returns 400 for a control-character displayName', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true })
  const res = await app.request('/organizations', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: 'bad\nname' }),
  })
  assertEquals(res.status, 400)
})

test('GET /organizations lists orgs for a platform admin session', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true })
  const res = await app.request('/organizations', {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 200)
  const body = await res.json() as { organizations: Array<{ id: string }> }
  assertEquals(body.organizations.length, 1)
  assertEquals(body.organizations[0]?.id, orgId)
})

test('GET /organizations/:id returns 404 when the org row is missing', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: false,
  })
  const res = await app.request(`/organizations/${orgId}`, {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('PATCH /organizations/:id returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    executeQueue: [[{ allowed: false }]],
  })
  const res = await app.request(`/organizations/${orgId}`, {
    method: 'PATCH',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: 'Renamed' }),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})

test('PATCH /organizations/:id returns 400 when displayName is missing', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request(`/organizations/${orgId}`, {
    method: 'PATCH',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 400)
})

test('PATCH /organizations/:id returns 400 for an empty displayName', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request(`/organizations/${orgId}`, {
    method: 'PATCH',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: '' }),
  })
  assertEquals(res.status, 400)
})

test('PUT /default-timezone returns 400 for an invalid timezone', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request(`/organizations/${orgId}/default-timezone`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ defaultServerTimezone: 'Not/AZone' }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid defaultServerTimezone' })
})

test('PUT /default-environment returns 400 when the field is missing', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request(`/organizations/${orgId}/default-environment`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 400)
})

test('GET /server-capacity returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    executeQueue: [[{ allowed: false }]],
  })
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})

test('PUT /server-capacity returns 403 when the caller is not an owner', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ownAllowed: false,
    executeQueue: [[{ allowed: false }]],
  })
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ maxServers: 3 }),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})

test('PUT /server-capacity returns 400 for a non-integer maxServers', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ownAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request(`/organizations/${orgId}/server-capacity`, {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ maxServers: 1.5 }),
  })
  assertEquals(res.status, 400)
})

test('GET /timezones returns the timezone catalog for a signed-in session', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true })
  const res = await app.request('/timezones', {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 200)
  const body = await res.json() as { timezones: string[] }
  assertEquals(Array.isArray(body.timezones), true)
  assertEquals(body.timezones.length > 0, true)
})
