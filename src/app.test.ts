import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import { createApp, type AppEnv } from './app.ts'
import { HEALTH_PATH } from './surfaces.ts'
import type { AuthRateLimiter } from './client/authn/auth-rate-limit.ts'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from './client/authn/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET, parseTestSecretsConfig } from './test-fixtures/secrets.ts'
import type { Db } from './db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const FAKE_DB = { tag: 'db' } as unknown as Db

async function secretsBundle() {
  const secretsConfig = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    'workers')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    'email-otp-verifier',
  )
  return { secrets, otpVerifierSecrets }
}

test('createApp serves root text and health JSON', async () => {
  const app = createApp({ signupEnvOverride: undefined })
  const root = await app.request('https://panel.example.com/')
  assertEquals(await root.text(), 'TurboPanel')

  const health = await app.request(`https://panel.example.com${HEALTH_PATH}`)
  assertEquals(health.status, 200)
  assertEquals(await health.json(), { ok: true })
})

test('createApp injects runtime and optional dependencies into context', async () => {
  const { secrets, otpVerifierSecrets } = await secretsBundle()
  const authRateLimiter: AuthRateLimiter = {
    check: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    reset: () => undefined,
  }
  const emailQueue = { enqueue: () => Promise.resolve() }
  const commandQueue = { enqueue: () => Promise.resolve() }

  const app = createApp({
    db: FAKE_DB,
    emailQueue,
    commandQueue,
    emailFrom: 'noreply@example.com',
    baseUrl: 'https://panel.example.com',
    secrets,
    otpVerifierSecrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    authRateLimiter,
    dataEncryptionSecrets: secrets,
    secretsConfig: parseTestSecretsConfig('deno'),
  })

  app.get('/probe', (c: Context<AppEnv>) =>
    c.json({
      runtime: c.get('runtime'),
      hasDb: c.get('db') === FAKE_DB,
      emailFrom: c.get('emailFrom'),
      baseUrl: c.get('baseUrl'),
      hasEmailQueue: c.get('emailQueue') === emailQueue,
      hasCommandQueue: c.get('commandQueue') === commandQueue,
      hasAuthLimiter: c.get('authRateLimiter') === authRateLimiter,
      hasDataSecrets: c.get('dataEncryptionSecrets') === secrets,
      hasSecretsConfig: c.get('secretsConfig') !== undefined,
    }))

  const res = await app.request('https://panel.example.com/probe')
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    runtime: 'deno',
    hasDb: true,
    emailFrom: 'noreply@example.com',
    baseUrl: 'https://panel.example.com',
    hasEmailQueue: true,
    hasCommandQueue: true,
    hasAuthLimiter: true,
    hasDataSecrets: true,
    hasSecretsConfig: true,
  })
})

test('createApp defaults runtime to workers when omitted', async () => {
  const app = createApp({ signupEnvOverride: undefined })
  app.get('/runtime', (c: Context<AppEnv>) => c.text(c.get('runtime') ?? 'missing'))
  const res = await app.request('https://panel.example.com/runtime')
  assertEquals(await res.text(), 'workers')
})
