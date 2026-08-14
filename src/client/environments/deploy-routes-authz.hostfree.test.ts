/**
 * Host-free coverage for deploy authorize helpers (no Postgres / orchestration).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
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
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import {
  authorizeDeployRequest,
  authorizeEnvironmentManage,
  registerEnvironmentDeployPreviewRoutes,
  registerEnvironmentDeployRoutes,
  registerEnvironmentLifecycleRoutes,
  registerEnvironmentStopRoutes,
} from './deploy-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const environmentId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'

function thenableLimit(rows: unknown[]) {
  return {
    limit: () => Promise.resolve(rows),
  }
}

function mockContext(opts: {
  session?: { userId: string } | null
  db?: Db
  bodyText?: string
  headers?: Record<string, string>
}): Context<AppEnv> {
  const headers = opts.headers ?? {}
  const vars = new Map<string, unknown>()
  if (opts.db) vars.set('db', opts.db)
  if (opts.session !== undefined) vars.set('session', opts.session)

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name],
      query: () => undefined,
      text: () => Promise.resolve(opts.bodyText ?? ''),
    },
    get: (key: string) => vars.get(key),
    json: (body: unknown, status?: number) =>
      Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>
}

function buildOrgDb(opts: {
  organizationId: string | null
  manageAllowed: boolean
  workspaceKind?: string | null
}): Db {
  const executeResults: unknown[][] = []
  if (opts.organizationId) {
    executeResults.push([{ organization_id: opts.organizationId }])
  } else {
    executeResults.push([])
  }
  executeResults.push([{ allowed: opts.manageAllowed }])
  if (opts.manageAllowed) {
    let kindRows: unknown[]
    if (opts.workspaceKind === undefined) {
      kindRows = [{ kind: 'user' }]
    } else if (opts.workspaceKind === null) {
      kindRows = []
    } else {
      kindRows = [{ kind: opts.workspaceKind }]
    }
    executeResults.push(kindRows)
  }

  let executePhase = 0
  return {
    select: () => ({
      from: () => ({
        where: () => thenableLimit([{ role: 'superadmin' }]),
      }),
    }),
    execute: () => {
      const rows = executeResults[executePhase] ?? []
      executePhase += 1
      return Promise.resolve(rows)
    },
  } as unknown as Db
}

test('authorizeEnvironmentManage returns 401 without a session', async () => {
  const c = mockContext({ session: null, db: {} as Db })
  const result = await authorizeEnvironmentManage(c, {} as Db, environmentId)
  assertEquals(result instanceof Response, true)
  if (!(result instanceof Response)) return
  assertEquals(result.status, 401)
  assertEquals(await result.json(), { error: 'Unauthorized' })
})

test('authorizeEnvironmentManage returns 404 when environment org mismatches', async () => {
  const db = buildOrgDb({ organizationId: null, manageAllowed: true })
  const c = mockContext({
    session: { userId: 'user-1' },
    db,
    headers: { [ORG_ID_HEADER]: organizationId },
  })
  const result = await authorizeEnvironmentManage(c, db, environmentId)
  assertEquals(result instanceof Response, true)
  if (!(result instanceof Response)) return
  assertEquals(result.status, 404)
  assertEquals(await result.json(), { error: 'Not found' })
})

test('authorizeEnvironmentManage returns 403 when manage is denied', async () => {
  const db = buildOrgDb({
    organizationId,
    manageAllowed: false,
  })
  const c = mockContext({
    session: { userId: 'user-1' },
    db,
    headers: { [ORG_ID_HEADER]: organizationId },
  })
  const result = await authorizeEnvironmentManage(c, db, environmentId)
  assertEquals(result instanceof Response, true)
  if (!(result instanceof Response)) return
  assertEquals(result.status, 403)
  assertEquals(await result.json(), { error: 'Forbidden' })
})

test('authorizeEnvironmentManage returns 403 for system-owned environments', async () => {
  const db = buildOrgDb({
    organizationId,
    manageAllowed: true,
    workspaceKind: 'turbopanel',
  })
  const c = mockContext({
    session: { userId: 'user-1' },
    db,
    headers: { [ORG_ID_HEADER]: organizationId },
  })
  const result = await authorizeEnvironmentManage(c, db, environmentId)
  assertEquals(result instanceof Response, true)
  if (!(result instanceof Response)) return
  assertEquals(result.status, 403)
  assertEquals(await result.json(), { error: 'system_resource_immutable' })
})

test('authorizeEnvironmentManage returns auth payload when manage is allowed', async () => {
  const db = buildOrgDb({
    organizationId,
    manageAllowed: true,
    workspaceKind: 'user',
  })
  const c = mockContext({
    session: { userId: 'user-1' },
    db,
    headers: { [ORG_ID_HEADER]: organizationId },
  })
  const result = await authorizeEnvironmentManage(c, db, environmentId)
  assertEquals(result instanceof Response, false)
  assertEquals(result, {
    userId: 'user-1',
    organizationId,
  })
})

test('authorizeDeployRequest returns 400 for a non-object JSON body', async () => {
  const db = buildOrgDb({
    organizationId,
    manageAllowed: true,
    workspaceKind: 'user',
  })
  const c = mockContext({
    session: { userId: 'user-1' },
    db,
    headers: { [ORG_ID_HEADER]: organizationId },
    bodyText: '[]',
  })
  const result = await authorizeDeployRequest(c, db, environmentId)
  assertEquals(result instanceof Response, true)
  if (!(result instanceof Response)) return
  assertEquals(result.status, 400)
  assertEquals(await result.json(), { error: 'Invalid request' })
})

test('authorizeDeployRequest returns flags when manage is allowed', async () => {
  const db = buildOrgDb({
    organizationId,
    manageAllowed: true,
    workspaceKind: null,
  })
  const c = mockContext({
    session: { userId: 'user-1' },
    db,
    headers: { [ORG_ID_HEADER]: organizationId },
    bodyText: JSON.stringify({
      acknowledgeHealthCheckWarnings: true,
      noCache: true,
    }),
  })
  const result = await authorizeDeployRequest(c, db, environmentId)
  assertEquals(result instanceof Response, false)
  assertEquals(result, {
    userId: 'user-1',
    organizationId,
    acknowledgeHealthCheckWarnings: true,
    noCache: true,
  })
})

test('POST /environments/:id/deploy returns 401 without a session cookie', async () => {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerEnvironmentDeployRoutes(app, { secrets, runtime: 'deno' })
  const res = await app.request(`/environments/${environmentId}/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('POST /environments/:id/deploy returns 403 when manage is denied', async () => {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `deploy-authz-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `deploy-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })

  let executePhase = 0
  const authDb = createMockAuthDb(state)
  const db = Object.assign(authDb, {
    execute: () => {
      executePhase += 1
      if (executePhase === 1) {
        return Promise.resolve([{ organization_id: organizationId }])
      }
      return Promise.resolve([{ allowed: false }])
    },
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerEnvironmentDeployRoutes(app, { secrets, runtime: 'deno' })

  const res = await app.request(`/environments/${environmentId}/deploy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: `${HTTP_SESSION_COOKIE_NAME}=${signed}`,
      [ORG_ID_HEADER]: organizationId,
    },
    body: JSON.stringify({}),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})

test('deploy stop / lifecycle / preview routes return 401 without a session cookie', async () => {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerEnvironmentStopRoutes(app, { secrets, runtime: 'deno' })
  registerEnvironmentLifecycleRoutes(app, { secrets, runtime: 'deno' })
  registerEnvironmentDeployPreviewRoutes(app, { secrets, runtime: 'deno' })

  const paths = [
    ['POST', `/environments/${environmentId}/stop`],
    ['POST', `/environments/${environmentId}/lifecycle`],
    ['GET', `/environments/${environmentId}/deploy-preview`],
  ] as const

  for (const [method, path] of paths) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({ action: 'start' }),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})
