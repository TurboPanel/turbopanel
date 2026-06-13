import type { Hono } from 'hono'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './auth/secrets.ts'
import { createApp } from './app'
import { createWorkersDb } from './db'
import { registerDeveloperRoutesCore } from './developer-routes-core.ts'
import { createNoopQueue } from './email/noop-queue.ts'
import { createWorkersMailgunQueue } from './email/workers-queue.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSecrets: DerivedSecretsConfig | null = null

async function initWorkerApp(env: CloudflareBindings) {
  const secretsConfig = parseSecretsEnv(
    env.TURBOPANEL_SECRET,
    env.TURBOPANEL_SECRETS,
    'workers',
  )
  cachedSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const db = env.HYPERDRIVE ? createWorkersDb(env.HYPERDRIVE) : undefined
  const mailgunApiKey = env.TURBOPANEL_MAILGUN_API_KEY?.trim() ?? ''
  const mailgunDomain = env.TURBOPANEL_MAILGUN_DOMAIN?.trim() ?? ''
  const emailQueue = mailgunApiKey !== '' && mailgunDomain !== ''
    ? createWorkersMailgunQueue({
      apiKey: mailgunApiKey,
      domain: mailgunDomain,
    })
    : createNoopQueue()
  cachedApp = createApp({
    db,
    emailQueue,
    secrets: cachedSecrets,
    runtime: 'workers',
    corsOrigins: env.TURBOPANEL_CORS_ORIGINS,
    signupEnvOverride: env.TURBOPANEL_IS_SIGNUP_ENABLED,
    emailFrom: env.TURBOPANEL_SYSTEM_EMAIL_FROM ?? 'noreply@turbopanel.local',
  })
  registerDeveloperRoutesCore(cachedApp as unknown as Hono, {
    secrets: cachedSecrets,
    db,
    authRequired: false,
  })
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    if (!initPromise) initPromise = initWorkerApp(env)
    await initPromise
    return cachedApp!.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
