/**
 * Host-free coverage: a control plane without a billing surface answers every
 * `/billing/*` path with `503 billing_not_configured` after the session check.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { registerBillingUnavailableRoutes } from './unavailable.ts'

const test = Deno.test.bind(Deno)

async function buildApp(): Promise<{ app: Hono<AppEnv>; cookie: string }> {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  const email = `billing-${crypto.randomUUID()}@example.com`
  seedMockSession(state, token, { sessionId: crypto.randomUUID(), userId, email, role: 'user' })
  seedMockUser(state, {
    id: userId,
    email,
    isDisabled: false,
    isEmailVerified: true,
    role: 'user',
  })
  const db = createMockAuthDb(state)
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerBillingUnavailableRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return { app, cookie }
}

const CASES = [
  ['GET', '/billing/catalog'],
  ['GET', '/billing/subscription'],
  ['GET', '/billing/status'],
  ['POST', '/billing/checkout'],
] as const

for (const [method, path] of CASES) {
  test(`${method} ${path} answers 503 billing_not_configured when signed in`, async () => {
    const { app, cookie } = await buildApp()
    const res = await app.request(path, { method, headers: { Cookie: cookie } })
    assertEquals(res.status, 503)
    assertEquals(await res.json(), { error: 'billing_not_configured' })
  })

  test(`${method} ${path} still asks for a session first`, async () => {
    const { app } = await buildApp()
    const res = await app.request(path, { method })
    assertEquals(res.status, 401)
  })
}
