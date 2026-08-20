/**
 * Host-free coverage for IP route authz and create/patch/delete 4xx arms
 * (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { hosting, ip } from '../../lib/db/schema.ts'
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
import { registerIpRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const id = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

const IP_PATHS = [
  ['GET', '/ips'],
  ['POST', '/ips'],
  ['GET', `/ips/${id}`],
  ['PATCH', `/ips/${id}`],
  ['DELETE', `/ips/${id}`],
] as const

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerIpRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

type SessionAppOpts = {
  manageAllowed: boolean
  executeQueue?: unknown[][]
  /** Select doubles for ip / hosting rows past authz. */
  ipRow?: {
    organizationId: string
    scope?: string
    address?: string
    serverId?: string | null
    datacenterId?: string | null
    networkId?: string | null
  } | null
  hostingUsesIp?: boolean
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
    email: `ip-authz-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `ip-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'IP Org' })

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
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === ip && opts.ipRow) {
          const row = {
            id,
            organizationId: opts.ipRow.organizationId,
            datacenterId: opts.ipRow.datacenterId ?? null,
            networkId: opts.ipRow.networkId ?? null,
            serverId: opts.ipRow.serverId ?? null,
            address: opts.ipRow.address ?? '203.0.113.10',
            allocation: 'dedicated',
            scope: opts.ipRow.scope ?? 'public',
            description: null,
            metadata: null,
            options: null,
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z',
          }
          return {
            where: () => ({
              limit: () => Promise.resolve([row]),
              orderBy: () => Promise.resolve([row]),
            }),
          }
        }
        if (table === ip && opts.ipRow === null) {
          return {
            where: () => ({
              limit: () => Promise.resolve([]),
            }),
          }
        }
        if (table === hosting) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(
                  opts.hostingUsesIp ? [{ id: crypto.randomUUID() }] : [],
                ),
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
  registerIpRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
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

test('registerIpRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerIpRoutes(app, {
      runtime: 'deno',
      signupEnvOverride: undefined,
    })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

test('ip routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  for (const [method, path] of IP_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({ address: '203.0.113.10', scope: 'public' }),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('GET /ips returns empty list when nothing is visible', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }], []],
  })
  const res = await app.request('/ips', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { ips: [] })
})

test('GET /ips returns 400 for an invalid scope filter', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }], [{ item_id: id }]],
  })
  const res = await app.request('/ips?scope=vpn', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('GET /ips returns 400 for a malformed datacenterId filter', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }], [{ item_id: id }]],
  })
  const res = await app.request('/ips?datacenterId=not-a-uuid', {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('GET /ips/:id returns 404 when the IP is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ipRow: { organizationId: '44444444-4444-4444-8444-444444444444' },
  })
  const res = await app.request(`/ips/${id}`, {
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('POST /ips returns 400 when version is client-supplied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request('/ips', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '203.0.113.10',
      scope: 'public',
      version: 4,
    }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('POST /ips returns 400 for an invalid address', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request('/ips', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ address: 'not-an-ip', scope: 'public' }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('POST /ips returns 400 when datacenter scope lacks datacenterId', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request('/ips', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '10.0.0.10',
      scope: 'datacenter',
      allocation: 'dedicated',
    }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('POST /ips returns 403 when create/manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    executeQueue: [[{ allowed: false }]],
  })
  const res = await app.request('/ips', {
    method: 'POST',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      address: '203.0.113.10',
      scope: 'public',
      allocation: 'dedicated',
    }),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})

test('PATCH /ips/:id returns 404 when the IP is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ipRow: { organizationId: '44444444-4444-4444-8444-444444444444' },
  })
  const res = await app.request(`/ips/${id}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ description: 'edge' }),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('PATCH /ips/:id returns 400 when address is mutated', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ipRow: { organizationId },
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request(`/ips/${id}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ address: '203.0.113.99' }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('PATCH /ips/:id returns 403 when organization:manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    ipRow: { organizationId },
    executeQueue: [[{ allowed: false }]],
  })
  const res = await app.request(`/ips/${id}`, {
    method: 'PATCH',
    headers: {
      ...sessionHeaders(cookie),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ description: 'edge' }),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})

test('DELETE /ips/:id returns 409 when a hosting pins the address', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ipRow: { organizationId },
    hostingUsesIp: true,
    executeQueue: [[{ allowed: true }]],
  })
  const res = await app.request(`/ips/${id}`, {
    method: 'DELETE',
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'ip_in_use' })
})

test('DELETE /ips/:id returns 404 when the IP is outside the org', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    ipRow: { organizationId: '44444444-4444-4444-8444-444444444444' },
  })
  const res = await app.request(`/ips/${id}`, {
    method: 'DELETE',
    headers: sessionHeaders(cookie),
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})
