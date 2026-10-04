import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { registerClientRoutes } from '../routes.ts'
import { createFailClosedAuthRateLimiter } from './auth-rate-limit.ts'

const test = Deno.test.bind(Deno)

/**
 * Every public (no session yet) client endpoint where someone can guess a
 * credential, a one-time code or a token, or make us send mail. With a limiter
 * that refuses everything, each must answer 429 with Retry-After before it does
 * any work — so adding such a route without a limiter check, or moving the check
 * behind the lookup, fails here.
 */
const THROTTLED: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/auth/sign-in'],
  ['POST', '/auth/sign-up'],
  ['POST', '/auth/send-otp'],
  ['POST', '/auth/verify-otp'],
  ['POST', '/auth/sign-in/otp'],
  ['POST', '/auth/sign-in/2fa'],
  ['POST', '/auth/reset-password/request-otp'],
  ['POST', '/auth/reset-password/otp'],
  ['POST', '/auth/request-password-reset'],
  ['POST', '/auth/reset-password'],
  ['GET', '/auth/invitations/by-token/some-token'],
  ['POST', '/auth/invitations/by-token/some-token/sign-up'],
  ['POST', '/auth/passkeys/login/options'],
  ['POST', '/auth/passkeys/login/verify'],
  ['GET', '/auth/oauth/github/start'],
  ['GET', '/auth/oauth/github/callback?code=x&state=y'],
]

async function buildDenyAllApp() {
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    c.set('authRateLimiter', createFailClosedAuthRateLimiter())
    return next()
  })
  registerClientRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return app
}

test('every credential, code and token endpoint is throttled before it does any work', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('rate-limit route matrix')
    return
  }
  const app = await buildDenyAllApp()
  const notThrottled: string[] = []
  for (const [method, path] of THROTTLED) {
    // eslint-disable-next-line no-await-in-loop -- sequential so one failure names its route
    const res = await app.request(`${CLIENT_API_PREFIX}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'X-Real-IP': '203.0.113.77',
        Origin: 'http://localhost',
      },
      ...(method === 'POST'
        ? { body: JSON.stringify({ email: 'someone@example.com', password: 'x' }) }
        : {}),
    })
    if (res.status !== 429 || res.headers.get('Retry-After') === null) {
      notThrottled.push(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 120)}`)
    }
  }
  assertEquals(notThrottled, [])
})
