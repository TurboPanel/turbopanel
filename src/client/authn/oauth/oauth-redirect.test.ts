/**
 * Checklist row auth-redirect: `redirectTo` never leaves the console. The
 * three probes the row names are sent to the real `/oauth/github/start` route
 * and the signed state it hands the provider is read back.
 */
import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../../app/surfaces.ts'
import { deriveSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import { createAuthRateLimiter } from '../auth-rate-limit.ts'
import { registerAuthRoutes } from '../http.ts'
import { verifyOAuthState } from './oauth-state.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep the alias so analysis sees these suites. */
const test = Deno.test.bind(Deno)

const ORIGIN = 'https://panel.example.com'

async function buildStartApp() {
  const config = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(config, 'session-signing')
  const limiter = createAuthRateLimiter({ defaultPolicy: { limit: 100, windowMs: 60_000 } })
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('secretsConfig', config)
    c.set('platformEnv', {
      TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_ID: 'gh-client',
      TURBOPANEL_AUTH_PROVIDERS__GITHUB_CLIENT_SECRET: 'gh-secret',
    })
    c.set('authRateLimiter', limiter)
    return next()
  })
  const client = new Hono<AppEnv>()
  registerAuthRoutes(client, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: '1',
    baseUrl: ORIGIN,
  })
  app.route(CLIENT_API_PREFIX, client)
  return { app, config }
}

async function signedRedirectFor(redirectTo: string): Promise<string | undefined> {
  const { app, config } = await buildStartApp()
  const res = await app.request(
    `${ORIGIN}${CLIENT_API_PREFIX}/auth/oauth/github/start?redirectTo=${encodeURIComponent(redirectTo)}`
  )
  assertEquals(res.status, 302)
  const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? ''
  return (await verifyOAuthState(config, state))?.redirectTo
}

test('the three off-site redirect probes all fall back to a local page', async () => {
  const probes = ['/%09/evil.com', '//evil.com', '/\\evil.com']
  const signed = await Promise.all(probes.map((probe) => signedRedirectFor(probe)))
  signed.forEach((redirectTo, index) => {
    assertEquals(redirectTo, '/', `probe ${JSON.stringify(probes[index])} survived`)
  })
})

test('an ordinary console path is kept', async () => {
  assertEquals(await signedRedirectFor('/servers'), '/servers')
})
