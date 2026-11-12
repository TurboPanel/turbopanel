/**
 * Host-free coverage for the cache route guards (no Postgres): a write to a
 * system-owned environment is refused, and a request without a session is 401.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerCacheRoutes } from './routes.ts'

const test = Deno.test.bind(Deno)

const environmentId = '11111111-1111-4111-8111-111111111111'
const cacheId = '66666666-6666-4666-8666-666666666666'
const organizationId = '22222222-2222-4222-8222-222222222222'

async function buildApp(systemOwned: boolean): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  const email = `cache-authz-${crypto.randomUUID()}@example.com`
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
  state.organizations.push({ id: organizationId, name: 'Cache Org' })
  const db = Object.assign(createMockAuthDb(state), {
    execute: () =>
      Promise.resolve([
        {
          allowed: true,
          organization_id: organizationId,
          kind: systemOwned ? 'turbopanel' : 'user',
        },
      ]),
  }) as unknown as Db
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerCacheRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return { app, cookie }
}

function headers(cookie: string): Record<string, string> {
  return { Cookie: cookie, [ORG_ID_HEADER]: organizationId, 'content-type': 'application/json' }
}

test('registerCacheRoutes requires session secrets', () => {
  let threw = false
  try {
    registerCacheRoutes(new Hono<AppEnv>(), { runtime: 'deno', signupEnvOverride: undefined })
  } catch (error) {
    threw = error instanceof TypeError
  }
  assertEquals(threw, true)
})

test('cache routes answer 401 without a session', async () => {
  const { app } = await buildApp(false)
  for (const [method, path] of [
    ['GET', `/environments/${environmentId}/caches`],
    ['POST', `/environments/${environmentId}/caches`],
    ['PATCH', `/environments/${environmentId}/caches/${cacheId}`],
    ['DELETE', `/environments/${environmentId}/caches/${cacheId}`],
  ] as const) {
    const res = await app.request(path, { method })
    assertEquals(res.status, 401, `${method} ${path}`)
  }
})

test('a write to a system-owned environment is refused with 403', async () => {
  const { app, cookie } = await buildApp(true)
  for (const [method, path] of [
    ['POST', `/environments/${environmentId}/caches`],
    ['PATCH', `/environments/${environmentId}/caches/${cacheId}`],
    ['DELETE', `/environments/${environmentId}/caches/${cacheId}`],
  ] as const) {
    const res = await app.request(path, {
      method,
      headers: headers(cookie),
      body: method === 'DELETE' ? undefined : JSON.stringify({}),
    })
    assertEquals(res.status, 403, `${method} ${path}`)
    assertEquals(await res.json(), { error: 'system_resource_immutable' })
  }
})
