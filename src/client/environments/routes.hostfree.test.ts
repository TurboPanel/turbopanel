/**
 * Host-free coverage for environment route authz short-circuits (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { environment } from '../../lib/db/schema.ts'
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
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerEnvironmentRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const environmentId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const projectId = '33333333-3333-4333-8333-333333333333'

const ENVIRONMENT_PATHS = [
  ['GET', '/environments'],
  ['POST', '/environments'],
  ['GET', `/environments/${environmentId}`],
  ['PATCH', `/environments/${environmentId}`],
  ['DELETE', `/environments/${environmentId}`],
] as const

async function buildApp(db: Db | undefined): Promise<Hono<AppEnv>> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    if (db) c.set('db', db)
    return next()
  })
  registerEnvironmentRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return app
}

async function buildSessionApp(opts: {
  manageAllowed: boolean
  /** Seed an environment entity row so GET/:id reaches assertCanReadOr403. */
  withEnvironmentRow?: boolean
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `env-authz-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `env-authz-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'Env Org' })

  let executePhase = 0
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)

  const db = Object.assign(authDb, {
    execute: () => {
      executePhase += 1
      if (executePhase === 1) {
        return Promise.resolve([{ organization_id: organizationId }])
      }
      return Promise.resolve([{ allowed: opts.manageAllowed }])
    },
    ...(opts.withEnvironmentRow
      ? {
        select: (fields?: unknown) => ({
          from: (table: unknown) => {
            if (table === environment) {
              return {
                where: () => ({
                  limit: () =>
                    Promise.resolve([{
                      id: environmentId,
                      name: 'Staging',
                      description: null,
                      projectId,
                      serverId: null,
                      metadata: {},
                      options: {},
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
  registerEnvironmentRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie }
}

test('registerEnvironmentRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerEnvironmentRoutes(app, {
      runtime: 'deno',
      signupEnvOverride: undefined,
    })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

test('environment routes return 401 without a session cookie', async () => {
  const app = await buildApp({} as Db)
  for (const [method, path] of ENVIRONMENT_PATHS) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE'
        ? undefined
        : JSON.stringify({ projectId: environmentId, name: 'Staging' }),
    })
    assertEquals(res.status, 401, `${method} ${path}`)
    assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
  }
})

test('GET /environments returns 401 when db is missing', async () => {
  const app = await buildApp(undefined)
  const res = await app.request('/environments')
  assertEquals(res.status, 401)
  assertEquals(await res.json(), { ok: false, error: 'Unauthorized' })
})

test('PATCH /environments/:id returns 403 when organization:manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false })
  const res = await app.request(`/environments/${environmentId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    },
    body: JSON.stringify({ name: 'Renamed' }),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})

test('DELETE /environments/:id returns 403 when organization:manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false })
  const res = await app.request(`/environments/${environmentId}`, {
    method: 'DELETE',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { ok: false, error: 'Forbidden' })
})

test('GET /environments/:id returns 403 when read/manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({
    manageAllowed: false,
    withEnvironmentRow: true,
  })
  const res = await app.request(`/environments/${environmentId}`, {
    method: 'GET',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})

test('POST /environments returns 403 when create/manage is denied', async () => {
  const { app, cookie } = await buildSessionApp({ manageAllowed: false })
  const res = await app.request('/environments', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    },
    body: JSON.stringify({ projectId, name: 'Staging' }),
  })
  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
})
