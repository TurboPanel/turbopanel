/**
 * Host-free coverage for environment deployment-history parsers and list/detail.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import {
  DEPLOYMENT_HISTORY_DEFAULT_LIMIT,
  DEPLOYMENT_HISTORY_MAX_LIMIT,
} from '../../lib/db/deployment-history.ts'
import type { ExecutionLogStore } from '../../lib/execution-logs/types.ts'
import { command, deployment } from '../../lib/db/schema.ts'
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
import {
  parseLimit,
  registerEnvironmentDeploymentHistoryRoutes,
} from './deployment-history-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const environmentId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const serverId = '33333333-3333-4333-8333-333333333333'
const deploymentId = '018f0000-0000-7000-8000-000000000001'

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return promise.then.bind(promise)
        if (prop === 'catch' || prop === 'finally') return undefined
        return () => chain
      },
    },
  )
  return chain
}

function historyCommandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: deploymentId,
    serverId,
    status: 'succeeded',
    context: {
      environmentId,
      generation: 3,
      desiredHash: 'abc',
      replicaCounts: { web: 1 },
    },
    actorType: 'user',
    actorId: 'actor-1',
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    queuedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:10.000Z',
    serverName: 'edge-1',
    ...overrides,
  }
}

test('parseLimit defaults omitted and empty to the page size', () => {
  assertEquals(parseLimit(undefined), DEPLOYMENT_HISTORY_DEFAULT_LIMIT)
  assertEquals(parseLimit(''), DEPLOYMENT_HISTORY_DEFAULT_LIMIT)
})

test('parseLimit rejects non-integers and values outside 1..max', () => {
  assertEquals(parseLimit('0'), null)
  assertEquals(parseLimit('1.5'), null)
  assertEquals(parseLimit('nope'), null)
  assertEquals(parseLimit(String(DEPLOYMENT_HISTORY_MAX_LIMIT + 1)), null)
})

test('parseLimit accepts an in-range integer', () => {
  assertEquals(parseLimit('1'), 1)
  assertEquals(parseLimit(String(DEPLOYMENT_HISTORY_MAX_LIMIT)), DEPLOYMENT_HISTORY_MAX_LIMIT)
})

test('registerEnvironmentDeploymentHistoryRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerEnvironmentDeploymentHistoryRoutes(app, {
      runtime: 'deno',
      signupEnvOverride: undefined,
    })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

async function buildHistoryApp(opts: {
  manageAllowed: boolean
  commandPages?: unknown[][]
  deploymentRows?: unknown[]
  logExists?: boolean
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `history-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `history-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'History Org' })

  const commandPages = [...(opts.commandPages ?? [])]
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)

  const db = Object.assign(authDb, {
    execute: () => {
      // History is read-gated: `assertCanReadOr403` → `can()` only.
      return Promise.resolve([{ allowed: opts.manageAllowed }])
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === command) {
          return thenableRows(commandPages.shift() ?? [])
        }
        if (table === deployment) {
          return thenableRows(opts.deploymentRows ?? [])
        }
        return origSelect(fields).from(table)
      },
    }),
  }) as unknown as Db

  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    if (opts.logExists !== undefined) {
      c.set(
        'executionLogStore',
        {
          exists: () => Promise.resolve(opts.logExists === true),
        } as unknown as ExecutionLogStore,
      )
    }
    await next()
  })
  registerEnvironmentDeploymentHistoryRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie }
}

function authHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
  }
}

test('GET /environments/:id/deployments returns 401 without a session', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  registerEnvironmentDeploymentHistoryRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  const res = await app.request(`/environments/${environmentId}/deployments`)
  assertEquals(res.status, 401)
})

test('GET /environments/:id/deployments returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildHistoryApp({ manageAllowed: false })
  const res = await app.request(`/environments/${environmentId}/deployments`, {
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 403)
})

test('GET /environments/:id/deployments rejects a bad limit', async () => {
  const { app, cookie } = await buildHistoryApp({ manageAllowed: true })
  const res = await app.request(
    `/environments/${environmentId}/deployments?limit=0`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(res.status, 400)
  assertEquals(await res.json(), {
    error: `limit must be an integer between 1 and ${DEPLOYMENT_HISTORY_MAX_LIMIT}`,
  })
})

test('GET /environments/:id/deployments serializes a page and cursor', async () => {
  const newer = historyCommandRow()
  const older = historyCommandRow({
    id: '018e0000-0000-7000-8000-000000000002',
    status: 'failed',
    errorCode: 'compose_empty',
    errorMessage: 'no services',
  })
  const { app, cookie } = await buildHistoryApp({
    manageAllowed: true,
    commandPages: [[newer, older]],
    logExists: true,
  })
  const res = await app.request(
    `/environments/${environmentId}/deployments?limit=1&before=${deploymentId}`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok: boolean
    deployments: Array<{ id: string; hasLog: boolean; status: string }>
    nextCursor: string | null
  }
  if (!body.ok || !Array.isArray(body.deployments)) {
    throw new TypeError('expected a deployment history page')
  }
  assertEquals(body.deployments.length, 1)
  assertEquals(body.deployments[0]?.id, deploymentId)
  assertEquals(body.deployments[0]?.hasLog, true)
  assertEquals(body.nextCursor, deploymentId)
})

test('GET /environments/:id/deployments/:id returns 404 when missing', async () => {
  const { app, cookie } = await buildHistoryApp({
    manageAllowed: true,
    commandPages: [[]],
  })
  const res = await app.request(
    `/environments/${environmentId}/deployments/${deploymentId}`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
})

test('GET /environments/:id/deployments/:id serializes detail plus current targets', async () => {
  const { app, cookie } = await buildHistoryApp({
    manageAllowed: true,
    commandPages: [
      [historyCommandRow()],
      [historyCommandRow()],
    ],
    deploymentRows: [
      {
        serverId,
        desiredGeneration: 3,
        appliedGeneration: 3,
        status: 'applied',
      },
    ],
    logExists: false,
  })
  const res = await app.request(
    `/environments/${environmentId}/deployments/${deploymentId}`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok: boolean
    deployment: {
      id: string
      environmentId: string
      generation: number
      commands: Array<{ id: string; hasLog: boolean }>
      servers: Array<{ serverId: string; deploymentStatus: string | null }>
    }
  }
  if (!body.ok || !body.deployment) {
    throw new TypeError('expected a deployment detail body')
  }
  assertEquals(body.deployment.id, deploymentId)
  assertEquals(body.deployment.environmentId, environmentId)
  assertEquals(body.deployment.generation, 3)
  assertEquals(body.deployment.commands.length, 1)
  assertEquals(body.deployment.commands[0]?.hasLog, false)
  assertEquals(body.deployment.servers[0]?.serverId, serverId)
  assertEquals(body.deployment.servers[0]?.deploymentStatus, 'applied')
})

test('GET /environments/:id/deployments/:id stands alone without a generation', async () => {
  const { app, cookie } = await buildHistoryApp({
    manageAllowed: true,
    commandPages: [
      [historyCommandRow({ context: { environmentId, desiredHash: 'legacy' } })],
    ],
    logExists: false,
  })
  const res = await app.request(
    `/environments/${environmentId}/deployments/${deploymentId}`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok: boolean
    deployment: { generation: number | null; commands: unknown[] }
  }
  if (!body.ok || !body.deployment) {
    throw new TypeError('expected a deployment detail body')
  }
  assertEquals(body.deployment.generation, null)
  assertEquals(body.deployment.commands.length, 1)
})
