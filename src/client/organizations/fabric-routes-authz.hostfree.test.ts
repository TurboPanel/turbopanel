/**
 * Host-free coverage for TurboFabric route authz short-circuits (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { fabric, network, relay, server } from '../../lib/db/schema.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from '../authn/authn-hostfree-doubles.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { registerOrganizationFabricRoutes } from './fabric-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const orgId = '11111111-1111-4111-8111-111111111111'
const serverId = '22222222-2222-4222-8222-222222222222'

const FABRIC_PATHS = [
  ['GET', `/organizations/${orgId}/fabric`],
  ['PUT', `/organizations/${orgId}/fabric`],
  ['PATCH', `/organizations/${orgId}/fabric/relays/${serverId}`],
  ['POST', `/organizations/${orgId}/fabric/apply`],
] as const

async function buildSessionApp(opts: {
  manageAllowed: boolean
  /** Seed an organization row so manage-gated handlers reach fabric lookups. */
  seedOrg?: boolean
  /** Stub dispatch infra for PUT enable/disable paths past authz. */
  withDispatch?: boolean
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-authz-${crypto.randomUUID()}@example.com`,
    role: 'user',
  })
  if (opts.seedOrg) {
    state.organizations.push({ id: orgId, name: 'Fabric Org' })
  }
  const authDb = createMockAuthDb(state)
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: opts.manageAllowed }]),
  }) as unknown as Db
  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (opts.withDispatch) {
      c.set('daemonCellRegistry', { cells: new Map() } as never)
      c.set('commandQueue', { enqueue: () => Promise.resolve() })
    }
    return next()
  })
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie }
}

test('TurboFabric routes return 401 without a session cookie', async () => {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  for (const [method, path] of FABRIC_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ enabled: true }),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('TurboFabric routes return 403 when organization:manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false })
  for (const [method, path] of FABRIC_PATHS) {
    const res = await app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: method === 'GET' ? undefined : JSON.stringify({ enabled: true }),
    })
    assertEquals(res.status, 403, `${method} ${path}`)
    assertEquals(await res.json(), { error: 'Forbidden' })
  }
})

test('PUT /fabric returns 400 for invalid body when manage is allowed', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true })
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: 'yes' }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('PATCH /fabric/relays/:serverId returns 400 for invalid body when manage is allowed', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true })
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ role: 'router' }),
    },
  )
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid role' })
})

test('POST /fabric/apply returns 409 when TurboFabric is not enabled', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  })
  const res = await app.request(`/organizations/${orgId}/fabric/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'TurboFabric is not enabled' })
})

test('PATCH /fabric/relays/:serverId returns 409 when TurboFabric is not enabled', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  })
  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ role: 'member' }),
    },
  )
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'TurboFabric is not enabled' })
})

test('PUT /fabric enabled:false returns settings when TurboFabric is already off', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
    withDispatch: true,
  })
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: false }),
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { enabled: false, relays: [] })
})

/** Candidate host CIDRs from `pickDefaultFabricHostCidr` — all occupied → route 409. */
const EXHAUSTED_HOST_CIDRS = [
  '10.250.0.0/16',
  '10.251.0.0/16',
  '10.252.0.0/16',
  '10.253.0.0/16',
] as const

function thenableRows<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
  })
}

async function buildFabricEnableApp(opts: {
  /** Overlay select doubles so occupiedCidrs exhausts the host pool. */
  exhaustHostCidrs?: boolean
  /**
   * Mutable fabric insert + empty server/relay selects so enable succeeds with
   * zero org servers (no ensureFabricRelays inserts / reconcile enqueues).
   */
  enableEmptyOrg?: boolean
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-enable-${crypto.randomUUID()}@example.com`,
    role: 'user',
  })
  state.organizations.push({ id: orgId, name: 'Fabric Org' })
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)
  const origInsert = (
    authDb as unknown as {
      insert: (table: unknown) => unknown
    }
  ).insert.bind(authDb)

  const fabrics: Array<{
    id: string
    organizationId: string
    cidr: string
    options: unknown
  }> = []

  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (opts.exhaustHostCidrs && table === network) {
          return {
            where: () =>
              thenableRows(EXHAUSTED_HOST_CIDRS.map((cidr) => ({ cidr }))),
          }
        }
        if (opts.exhaustHostCidrs && table === fabric) {
          return { where: () => thenableRows([]) }
        }
        if (opts.enableEmptyOrg && table === fabric) {
          return {
            where: () =>
              thenableRows(
                fabrics.map((row) => ({
                  id: row.id,
                  organizationId: row.organizationId,
                  cidr: row.cidr,
                  options: row.options,
                })),
              ),
          }
        }
        if (opts.enableEmptyOrg && (table === network || table === server || table === relay)) {
          return { where: () => thenableRows([]) }
        }
        return origSelect(fields).from(table)
      },
    }),
    insert: (table: unknown) => {
      if (opts.enableEmptyOrg && table === fabric) {
        return {
          values: (row: Record<string, unknown>) => {
            const record = {
              id: crypto.randomUUID(),
              organizationId: String(row.organizationId),
              cidr: String(row.cidr),
              options: row.options ?? null,
            }
            fabrics.push(record)
            return {
              returning: () => Promise.resolve([record]),
            }
          },
        }
      }
      return origInsert(table)
    },
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', { cells: new Map() } as never)
    c.set('commandQueue', { enqueue: () => Promise.resolve() })
    return next()
  })
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie }
}

test('PUT /fabric enabled:true returns 409 when host CIDR pool is exhausted', async () => {
  const { app, cookie } = await buildFabricEnableApp({ exhaustHostCidrs: true })
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true }),
  })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'fabric_cidr_unavailable' })
})

test('PUT /fabric enabled:true returns settings for an org with no servers', async () => {
  const { app, cookie } = await buildFabricEnableApp({ enableEmptyOrg: true })
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true }),
  })
  assertEquals(res.status, 200)
  const body = await res.json() as {
    enabled: boolean
    fabric: { id: string; cidr: string; mtu: number }
    relays: unknown[]
  }
  assertEquals(body.enabled, true)
  assertEquals(body.fabric.cidr, '10.250.0.0/16')
  assertEquals(body.fabric.mtu, 1420)
  assertEquals(typeof body.fabric.id, 'string')
  assertEquals(body.relays, [])
})

test('GET /fabric returns 404 when the organization row is missing', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: true })
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('GET /fabric returns disabled settings when TurboFabric is off', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  })
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    headers: { Cookie: cookie },
  })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { enabled: false, relays: [] })
})

test('POST /fabric/apply returns 503 when command dispatch is unavailable', async () => {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-apply-${crypto.randomUUID()}@example.com`,
    role: 'user',
  })
  state.organizations.push({ id: orgId, name: 'Fabric Org' })
  const fabricId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === fabric) {
          return {
            where: () =>
              thenableRows([{
                id: fabricId,
                organizationId: orgId,
                cidr: '10.250.0.0/16',
                options: null,
              }]),
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
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const res = await app.request(`/organizations/${orgId}/fabric/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 503)
})

test('PUT /fabric returns 503 when command dispatch is unavailable', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: true,
    seedOrg: true,
  })
  const res = await app.request(`/organizations/${orgId}/fabric`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ enabled: true }),
  })
  assertEquals(res.status, 503)
})

test('PATCH /fabric/relays/:serverId returns 404 when the relay is missing', async () => {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `fabric-relay-${crypto.randomUUID()}@example.com`,
    role: 'user',
  })
  state.organizations.push({ id: orgId, name: 'Fabric Org' })
  const fabricId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: true }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === fabric) {
          return {
            where: () =>
              thenableRows([{
                id: fabricId,
                organizationId: orgId,
                cidr: '10.250.0.0/16',
                options: null,
              }]),
          }
        }
        if (table === relay) {
          return { where: () => thenableRows([]) }
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
  registerOrganizationFabricRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const res = await app.request(
    `/organizations/${orgId}/fabric/relays/${serverId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ role: 'member' }),
    },
  )
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})
