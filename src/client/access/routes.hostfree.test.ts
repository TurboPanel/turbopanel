/**
 * Host-free coverage for access route validation, invite, and revoke arms
 * (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { grant, invitation } from '../../lib/db/schema.ts'
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
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerAccessRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const invitationId = '11111111-1111-4111-8111-111111111111'
const grantId = '22222222-2222-4222-8222-222222222222'
const organizationId = '33333333-3333-4333-8333-333333333333'
const resourceId = organizationId

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerAccessRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

type SessionAppOpts = {
  ownAllowed?: boolean
  email?: string
  /** Invitation row returned by select-from-invitation. */
  invitationRow?: Record<string, unknown> | null
  /** Grant row returned by select-from-grant for revoke. */
  grantRow?: Record<string, unknown> | null
  executeQueue?: unknown[][]
}

async function buildSessionApp(
  opts: SessionAppOpts = {},
): Promise<{ app: Hono<AppEnv>; cookie: string; email: string }> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const email = opts.email ?? `access-${crypto.randomUUID()}@example.com`
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'Access Org' })

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
      return Promise.resolve([{ allowed: opts.ownAllowed !== false }])
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === invitation) {
          const row = opts.invitationRow
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(row === undefined ? [] : row === null ? [] : [row]),
            }),
          }
        }
        if (table === grant) {
          const row = opts.grantRow
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(row === undefined ? [] : row === null ? [] : [row]),
              orderBy: () => Promise.resolve(row ? [row] : []),
            }),
          }
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
  registerAccessRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie, email }
}

test('access routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  const paths = [
    ['POST', `/invitations/${invitationId}/accept`],
    ['GET', '/access'],
    ['POST', '/access'],
    ['DELETE', `/access/${grantId}`],
    ['GET', '/access/check'],
    ['GET', '/access/resource-id'],
    ['GET', '/permissions'],
  ] as const

  for (const [method, path] of paths) {
    const res = await app.request(path, { method })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('POST /invitations/:id/accept returns 401 without a session when db is missing', async () => {
  const app = await buildApp(undefined)
  const res = await app.request(`/invitations/${invitationId}/accept`, {
    method: 'POST',
  })
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('GET /permissions returns the catalog for a signed-in session', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/permissions', {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 200)
  const body = await res.json() as { permissions: Array<{ key: string }> }
  assertEquals(Array.isArray(body.permissions), true)
  assertEquals(body.permissions.length > 0, true)
  assertEquals(body.permissions.some((entry) => entry.key === 'system:manage'), false)
  assertEquals(body.permissions.some((entry) => entry.key === 'system:operate'), true)
})

test('POST /invitations/:id/accept returns 404 when the invitation is missing', async () => {
  const { app, cookie } = await buildSessionApp({ invitationRow: null })
  const res = await app.request(`/invitations/${invitationId}/accept`, {
    method: 'POST',
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('POST /invitations/:id/accept returns 403 when emails do not match', async () => {
  const { app, cookie } = await buildSessionApp({
    invitationRow: {
      id: invitationId,
      email: 'other@example.com',
      teamId: crypto.randomUUID(),
      status: 'pending',
      expiresAt: '2099-01-01T00:00:00.000Z',
      grants: null,
    },
  })
  const res = await app.request(`/invitations/${invitationId}/accept`, {
    method: 'POST',
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})

test('GET /access returns 400 without resourceId', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/access', {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), {
    error: 'resourceId query parameter is required',
  })
})

test('GET /access returns 400 for an invalid resourceId', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/access?resourceId=not-a-uuid', {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid resourceId' })
})

test('GET /access/check returns 400 without query params', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/access/check', {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), {
    error: 'resourceId and permissionKey query parameters are required',
  })
})

test('GET /access/check returns 400 for an invalid permissionKey', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request(
    `/access/check?resourceId=${resourceId}&permissionKey=organization:delete`,
    { headers: { Cookie: cookie } },
  )
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid permissionKey' })
})

test('GET /access/resource-id returns 400 without kind/itemId', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/access/resource-id', {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), {
    error: 'kind and itemId query parameters are required',
  })
})

test('POST /access returns 400 for invalid JSON', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/access', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: '{',
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('POST /access returns 400 for deny effect', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/access', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      subjectKind: 'user',
      subjectId: resourceId,
      resourceId,
      effect: 'deny',
      permissionKey: 'organization:manage',
    }),
  })
  assertEquals(res.status, 400)
})

test('POST /access returns 400 for an unknown permissionKey', async () => {
  const { app, cookie } = await buildSessionApp()
  const res = await app.request('/access', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      subjectKind: 'user',
      subjectId: resourceId,
      resourceId,
      permissionKey: 'not-a-permission',
    }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'permissionKey is required' })
})

test('DELETE /access/:id returns 404 when the grant is missing', async () => {
  const { app, cookie } = await buildSessionApp({ grantRow: null })
  const res = await app.request(`/access/${grantId}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('DELETE /access/:id returns 403 when the caller is not an owner', async () => {
  const { app, cookie } = await buildSessionApp({
    ownAllowed: false,
    grantRow: {
      entityType: 'organization',
      entityId: organizationId,
      permission: 'organization:manage',
      actorId: crypto.randomUUID(),
    },
    executeQueue: [[{ allowed: false }]],
  })
  const res = await app.request(`/access/${grantId}`, {
    method: 'DELETE',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})
