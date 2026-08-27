/**
 * Host-free coverage for environment release parsers and GET/POST short-circuits.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { ServiceReleaseRecord } from '../../lib/db/releases.ts'
import { SERVICE_RELEASES_MAX_LIMIT } from '../../lib/db/releases.ts'
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
  parseRollbackBody,
  registerEnvironmentReleaseRoutes,
  releaseByService,
  releasePin,
} from './release-routes.ts'

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

function releaseRecord(
  overrides: Partial<ServiceReleaseRecord> = {},
): ServiceReleaseRecord {
  return {
    commandId: 'cmd-1',
    serverId,
    attempts: [{ commandId: 'cmd-1', serverId, status: 'succeeded' }],
    composeServiceName: 'web',
    releaseId: 'rel-1',
    sourceId: 'src-1',
    commitSha: 'a'.repeat(40),
    status: 'succeeded',
    queuedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    isLive: true,
    ...overrides,
  }
}

function commandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmd-1',
    serverId,
    status: 'succeeded',
    context: {
      environmentId,
      releases: [
        {
          composeServiceName: 'web',
          releaseId: 'rel-1',
          sourceId: 'src-1',
          commitSha: 'a'.repeat(40),
          commitMessage: 'feat: ship',
          commitAuthor: 'Ada',
        },
      ],
    },
    resultSummary: null,
    queuedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function deploymentRow(targetServerId = serverId) {
  return {
    id: `dep-${targetServerId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    metadata: null,
    options: null,
    environmentId,
    serverId: targetServerId,
    desiredGeneration: 1,
    appliedGeneration: 1,
    desiredHash: null,
    status: 'applied',
    lastCommandId: 'cmd-1',
    finishedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    outcome: 'applied',
  }
}

test('parseLimit treats omitted and empty as unset', () => {
  assertEquals(parseLimit(undefined), undefined)
  assertEquals(parseLimit(''), undefined)
})

test('parseLimit rejects non-integers and values outside 1..max', () => {
  assertEquals(parseLimit('0'), null)
  assertEquals(parseLimit('-1'), null)
  assertEquals(parseLimit('1.5'), null)
  assertEquals(parseLimit('nope'), null)
  assertEquals(parseLimit(String(SERVICE_RELEASES_MAX_LIMIT + 1)), null)
})

test('parseLimit accepts an in-range integer', () => {
  assertEquals(parseLimit('1'), 1)
  assertEquals(parseLimit(String(SERVICE_RELEASES_MAX_LIMIT)), SERVICE_RELEASES_MAX_LIMIT)
})

test('parseRollbackBody requires both wire fields', () => {
  assertEquals(parseRollbackBody({}), null)
  assertEquals(parseRollbackBody({ composeServiceName: 'web' }), null)
  assertEquals(parseRollbackBody({ releaseId: 'rel-1' }), null)
  assertEquals(
    parseRollbackBody({ composeServiceName: '-bad', releaseId: 'rel-1' }),
    null,
  )
  assertEquals(
    parseRollbackBody({ composeServiceName: 'web', releaseId: '' }),
    null,
  )
  assertEquals(
    parseRollbackBody({ composeServiceName: 'web', releaseId: 'rel-1' }),
    { composeServiceName: 'web', releaseId: 'rel-1' },
  )
})

test('releasePin carries recorded commit metadata only when present', () => {
  assertEquals(releasePin(releaseRecord()), {
    releaseId: 'rel-1',
    commitSha: 'a'.repeat(40),
  })
  assertEquals(
    releasePin(
      releaseRecord({
        commitMessage: 'feat: ship',
        commitAuthor: 'Ada',
      }),
    ),
    {
      releaseId: 'rel-1',
      commitSha: 'a'.repeat(40),
      commitMessage: 'feat: ship',
      commitAuthor: 'Ada',
    },
  )
})

test('releaseByService pins live materialized releases plus the target', () => {
  const liveOther = releaseRecord({
    composeServiceName: 'worker',
    releaseId: 'rel-worker',
    isLive: true,
  })
  const notLive = releaseRecord({
    composeServiceName: 'cron',
    releaseId: 'rel-cron',
    isLive: false,
  })
  const notEverywhere = releaseRecord({
    composeServiceName: 'api',
    releaseId: 'rel-api',
    isLive: true,
    attempts: [{ commandId: 'cmd-old', serverId: 'other-host', status: 'succeeded' }],
  })
  const target = releaseRecord({
    composeServiceName: 'web',
    releaseId: 'rel-old',
    isLive: false,
    commitMessage: 'old',
  })
  const pins = releaseByService(
    [liveOther, notLive, notEverywhere, target],
    target,
    new Set([serverId]),
  )
  assertEquals(Object.keys(pins).sort((a, b) => a.localeCompare(b)), [
    'web',
    'worker',
  ])
  assertEquals(pins.web?.releaseId, 'rel-old')
  assertEquals(pins.web?.commitMessage, 'old')
  assertEquals(pins.worker?.releaseId, 'rel-worker')
})

test('registerEnvironmentReleaseRoutes requires session secrets', () => {
  const app = new Hono<AppEnv>()
  let threw = false
  try {
    registerEnvironmentReleaseRoutes(app, {
      runtime: 'deno',
      signupEnvOverride: undefined,
    })
  } catch (error) {
    threw = true
    assertEquals(error instanceof TypeError, true)
  }
  assertEquals(threw, true)
})

async function buildReleaseApp(opts: {
  /**
   * GET `/releases` only calls `can()` (one execute). POST `/rollback` first
   * resolves the environment org, then `can()`, then workspace kind.
   */
  gate: 'read' | 'manage'
  manageAllowed: boolean
  commandRows?: unknown[]
  deploymentRows?: unknown[]
}): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `release-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `release-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'Release Org' })

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
      if (opts.gate === 'read') {
        return Promise.resolve([{ allowed: opts.manageAllowed }])
      }
      if (executePhase === 1) {
        return Promise.resolve([{ organization_id: organizationId }])
      }
      if (executePhase === 2) {
        return Promise.resolve([{ allowed: opts.manageAllowed }])
      }
      return Promise.resolve([{ kind: 'user' }])
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === command) {
          return thenableRows(opts.commandRows ?? [])
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
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerEnvironmentReleaseRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  return { app, cookie }
}

function authHeaders(cookie: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    Cookie: cookie,
    [ORG_ID_HEADER]: organizationId,
  }
}

test('GET /environments/:id/releases returns 401 without a session', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', {} as Db)
    return next()
  })
  registerEnvironmentReleaseRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })
  const res = await app.request(`/environments/${environmentId}/releases`)
  assertEquals(res.status, 401)
})

test('GET /environments/:id/releases returns 403 when manage is denied', async () => {
  const { app, cookie } = await buildReleaseApp({
    gate: 'read',
    manageAllowed: false,
  })
  const res = await app.request(`/environments/${environmentId}/releases`, {
    headers: authHeaders(cookie),
  })
  assertEquals(res.status, 403)
})

test('GET /environments/:id/releases rejects a bad limit and compose service', async () => {
  const { app, cookie } = await buildReleaseApp({
    gate: 'read',
    manageAllowed: true,
  })
  const badLimit = await app.request(
    `/environments/${environmentId}/releases?limit=0`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(badLimit.status, 400)
  assertEquals(await badLimit.json(), {
    error: `limit must be an integer between 1 and ${SERVICE_RELEASES_MAX_LIMIT}`,
  })

  const badName = await app.request(
    `/environments/${environmentId}/releases?composeServiceName=-nope`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(badName.status, 400)
  assertEquals(await badName.json(), { error: 'Invalid composeServiceName' })
})

test('GET /environments/:id/releases lists folded releases', async () => {
  const { app, cookie } = await buildReleaseApp({
    gate: 'read',
    manageAllowed: true,
    commandRows: [commandRow()],
  })
  const res = await app.request(
    `/environments/${environmentId}/releases?limit=10&composeServiceName=web`,
    { headers: authHeaders(cookie) },
  )
  assertEquals(res.status, 200)
  const body = await res.json() as {
    ok: boolean
    releases: Array<{ releaseId: string; isLive: boolean; composeServiceName: string }>
  }
  if (!body.ok || !Array.isArray(body.releases)) {
    throw new TypeError('expected a folded releases list')
  }
  assertEquals(body.releases.length, 1)
  assertEquals(body.releases[0]?.releaseId, 'rel-1')
  assertEquals(body.releases[0]?.isLive, true)
  assertEquals(body.releases[0]?.composeServiceName, 'web')
})

test('POST /environments/:id/rollback rejects an invalid body', async () => {
  const { app, cookie } = await buildReleaseApp({
    gate: 'manage',
    manageAllowed: true,
  })
  const res = await app.request(`/environments/${environmentId}/rollback`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ composeServiceName: 'web' }),
  })
  assertEquals(res.status, 400)
  assertEquals(await res.json(), { error: 'Invalid request' })
})

test('POST /environments/:id/rollback returns 404 when the release is missing', async () => {
  const { app, cookie } = await buildReleaseApp({
    gate: 'manage',
    manageAllowed: true,
    commandRows: [],
  })
  const res = await app.request(`/environments/${environmentId}/rollback`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ composeServiceName: 'web', releaseId: 'rel-1' }),
  })
  assertEquals(res.status, 404)
  const body = await res.json() as { error: string }
  assertEquals(body.error, 'release_not_found')
})

test('POST /environments/:id/rollback returns 409 when a host never published it', async () => {
  const { app, cookie } = await buildReleaseApp({
    gate: 'manage',
    manageAllowed: true,
    commandRows: [commandRow()],
    deploymentRows: [
      deploymentRow(serverId),
      deploymentRow('44444444-4444-4444-8444-444444444444'),
    ],
  })
  const res = await app.request(`/environments/${environmentId}/rollback`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ composeServiceName: 'web', releaseId: 'rel-1' }),
  })
  assertEquals(res.status, 409)
  const body = await res.json() as { error: string }
  assertEquals(body.error, 'release_not_materialized')
})

test('POST /environments/:id/rollback returns 503 when dispatch infra is missing', async () => {
  const { app, cookie } = await buildReleaseApp({
    gate: 'manage',
    manageAllowed: true,
    commandRows: [commandRow()],
    deploymentRows: [deploymentRow()],
  })
  const res = await app.request(`/environments/${environmentId}/rollback`, {
    method: 'POST',
    headers: authHeaders(cookie),
    body: JSON.stringify({ composeServiceName: 'web', releaseId: 'rel-1' }),
  })
  assertEquals(res.status, 503)
  const body = await res.json() as { error: string }
  assertEquals(body.error, 'Daemon cell registry unavailable')
})
