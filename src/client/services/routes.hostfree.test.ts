/**
 * Host-free coverage for service route authz, list filters, and create/patch
 * error arms (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { service } from '../../lib/db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
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
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { SERVICE_CREATE_NOT_SUPPORTED } from './routes-helpers.ts'
import { registerServiceRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const serviceId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const environmentId = '33333333-3333-4333-8333-333333333333'

const SERVICE_PATHS = [
  ['GET', '/services'],
  ['POST', '/services'],
  ['GET', `/services/${serviceId}`],
  ['PATCH', `/services/${serviceId}`],
  ['DELETE', `/services/${serviceId}`],
] as const

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerServiceRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return app
}

type SessionAppOpts = {
  manageAllowed: boolean
  /** Queued `db.execute` results (listVisible / resolveEntityOrg / can). */
  executeQueue?: unknown[][]
  /** Seed a service row so GET/:id reaches assertCanReadOr403. */
  withServiceRow?: boolean
}

async function buildSessionApp(
  opts: SessionAppOpts,
): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `svc-authz-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `svc-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'Service Org' })

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
      return Promise.resolve([{ allowed: opts.manageAllowed }])
    },
    ...(opts.withServiceRow
      ? {
        select: (fields?: unknown) => ({
          from: (table: unknown) => {
            if (table === service) {
              return {
                where: () => ({
                  limit: () =>
                    Promise.resolve([{
                      id: serviceId,
                      name: 'Web',
                      description: null,
                      environmentId,
                      composeServiceName: 'web',
                      metadata: null,
                      options: null,
                      createdAt: '2020-01-01T00:00:00.000Z',
                      updatedAt: '2020-01-01T00:00:00.000Z',
                    }]),
                  orderBy: () =>
                    Promise.resolve([{
                      id: serviceId,
                      name: 'Web',
                      description: null,
                      environmentId,
                      composeServiceName: 'web',
                      metadata: null,
                      options: null,
                      createdAt: '2020-01-01T00:00:00.000Z',
                      updatedAt: '2020-01-01T00:00:00.000Z',
                    }]),
                }),
              }
            }
            return origSelect(fields).from(table)
          },
        }),
      }
      : {}),
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerServiceRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, cookie }
}

function sessionHeaders(
  cookie: string,
  extras?: Record<string, string>,
): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
    ...extras,
  }
}

test('service routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  for (const [method, path] of SERVICE_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({}),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('GET /services returns 401 when db is missing', async () => {
  const app = await buildApp(undefined)
  const res = await app.request('/services')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('GET /services returns empty list when nothing is visible', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[]],
  })
  const res = await app.request('/services', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { services: [] })
})

test('GET /services with list filters still returns empty when nothing is visible', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[]],
  })
  const res = await app.request(
    `/services?environmentId=${environmentId}&composeServiceName=web`,
    { headers: sessionHeaders(cookie) },
  )
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { services: [] })
})

test('GET /services/:id returns 404 when the service is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[]],
  })
  const res = await app.request(`/services/${serviceId}`, {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('GET /services/:id returns 403 when read/manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    withServiceRow: true,
    executeQueue: [[{ organization_id: organizationId }], [{ allowed: false }]],
  })
  const res = await app.request(`/services/${serviceId}`, {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})

test('POST /services returns 400 when environmentId is missing', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true })
  const res = await app.request('/services', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Web' }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('POST /services returns 404 when environment is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[]],
  })
  const res = await app.request('/services', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ environmentId }),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('POST /services returns compose_service_name_read_only with message', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [
      [{ organization_id: organizationId }],
      [{ allowed: true }],
    ],
  })
  const res = await app.request('/services', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      environmentId,
      composeServiceName: 'web',
    }),
  })
  assertEquals(res.status, 400)
  const body = await res.json() as { error: string; message: string }
  assertEquals(body.error, 'compose_service_name_read_only')
  assertEquals(typeof body.message, 'string')
})

test('POST /services returns service_create_not_supported when fields are valid', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [
      [{ organization_id: organizationId }],
      [{ allowed: true }],
    ],
  })
  const res = await app.request('/services', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      environmentId,
      name: 'API',
    }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), SERVICE_CREATE_NOT_SUPPORTED)
})

test('PATCH /services/:id returns 404 when the service is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[]],
  })
  const res = await app.request(`/services/${serviceId}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Renamed' }),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('PATCH /services/:id returns 403 when organization:manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    executeQueue: [[{ organization_id: organizationId }], [{ allowed: false }]],
  })
  const res = await app.request(`/services/${serviceId}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Renamed' }),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})

test('PATCH /services/:id returns compose name rejection with message', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [
      [{ organization_id: organizationId }],
      [{ allowed: true }],
      [],
    ],
  })
  const res = await app.request(`/services/${serviceId}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ composeServiceName: 'web' }),
  })
  assertEquals(res.status, 400)
  const body = await res.json() as { error: string; message: string }
  assertEquals(body.error, 'compose_service_name_read_only')
  assertEquals(typeof body.message, 'string')
})

test('DELETE /services/:id returns 403 when organization:manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    executeQueue: [[{ organization_id: organizationId }], [{ allowed: false }]],
  })
  const res = await app.request(`/services/${serviceId}`, {
    method: 'DELETE',
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})

test('DELETE /services/:id returns 404 when the service is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[]],
  })
  const res = await app.request(`/services/${serviceId}`, {
    method: 'DELETE',
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})
