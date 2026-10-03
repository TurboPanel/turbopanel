import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import {
  composeRemoteBuildSourcesResponse,
  parseComposeRemoteBuildSourcesPatch,
  registerComposeRemoteBuildSourcesRoutes,
} from './compose-remote-build-sources-routes.ts'
import { registerOrganizationSessionGuards } from './session-guards.ts'

const test = Deno.test.bind(Deno)

const orgId = '11111111-1111-4111-8111-111111111111'
const PATH = `/organizations/${orgId}/compose-remote-build-sources`

async function buildApp(ownAllowed: boolean, orgOptions: unknown = null) {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const email = `remote-build-${crypto.randomUUID()}@example.com`
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
  state.organizations.push({ id: orgId, name: 'Org Routes' })
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as { select: (fields?: unknown) => { from: (table: unknown) => unknown } }
  ).select.bind(authDb)
  const db = Object.assign(authDb, {
    execute: () => Promise.resolve([{ allowed: ownAllowed }]),
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table !== organization) return origSelect(fields).from(table)
        const rows = [{ id: orgId, options: orgOptions }]
        return Object.assign(Promise.resolve(rows), {
          where: () => ({ limit: () => Promise.resolve(rows) }),
        })
      },
    }),
  }) as unknown as Db
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerOrganizationSessionGuards(app, secrets)
  registerComposeRemoteBuildSourcesRoutes(app)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return { app, cookie }
}

test('remote build sources: a boolean is required, and the setting defaults to off', () => {
  assertEquals(parseComposeRemoteBuildSourcesPatch({ composeRemoteBuildSourcesEnabled: true }), {
    ok: true,
    patch: { composeRemoteBuildSourcesEnabled: true },
  })
  assertEquals(parseComposeRemoteBuildSourcesPatch({ composeRemoteBuildSourcesEnabled: 'yes' }), {
    ok: false,
    error: 'Invalid composeRemoteBuildSourcesEnabled',
    status: 400,
  })
  assertEquals(composeRemoteBuildSourcesResponse({}), { composeRemoteBuildSourcesEnabled: false })
  assertEquals(composeRemoteBuildSourcesResponse({ composeRemoteBuildSourcesEnabled: true }), {
    composeRemoteBuildSourcesEnabled: true,
  })
})

for (const method of ['GET', 'PUT']) {
  test(`${method} /compose-remote-build-sources returns 403 when the caller is not an owner`, async () => {
    const { app, cookie } = await buildApp(false)
    const res = await app.request(PATH, {
      method,
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body:
        method === 'PUT' ? JSON.stringify({ composeRemoteBuildSourcesEnabled: true }) : undefined,
    })
    assertEquals(res.status, 403)
  })
}

test('GET /compose-remote-build-sources answers 401 without a session and reads the setting for an owner', async () => {
  const { app, cookie } = await buildApp(true, { composeRemoteBuildSourcesEnabled: true })
  assertEquals((await app.request(PATH)).status, 401)
  const res = await app.request(PATH, { headers: { Cookie: cookie } })
  assertEquals(res.status, 200)
  assertEquals(await res.json(), { composeRemoteBuildSourcesEnabled: true })
})

test('PUT /compose-remote-build-sources rejects a non-boolean body for an owner', async () => {
  const { app, cookie } = await buildApp(true)
  const res = await app.request(PATH, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ composeRemoteBuildSourcesEnabled: 'yes' }),
  })
  assertEquals(res.status, 400)
})
