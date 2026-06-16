import { Hono } from 'hono'
import type { Hono as HonoType } from 'hono'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './auth/secrets.ts'
import { createApp, type AppEnv } from './app'
import { createWorkersDb } from './db'
import { registerDeveloperRoutesCore } from './developer-routes-core.ts'
import { registerWorkersDaemonWebSocket } from './workers-ws.ts'
import { createNoopQueue } from './email/noop-queue.ts'
import { createWorkersMailgunQueue } from './email/workers-queue.ts'
import type { EmailQueue } from './email/types.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSecrets: DerivedSecretsConfig | null = null
let cachedEmailQueue: EmailQueue | null = null

async function initWorkerApp(env: CloudflareBindings) {
  const secretsConfig = parseSecretsEnv(
    env.TURBOPANEL_SECRET,
    env.TURBOPANEL_SECRETS,
    'workers',
  )
  cachedSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const mailgunApiKey = env.TURBOPANEL_MAILGUN_API_KEY?.trim() ?? ''
  const mailgunDomain = env.TURBOPANEL_MAILGUN_DOMAIN?.trim() ?? ''
  cachedEmailQueue = mailgunApiKey !== '' && mailgunDomain !== ''
    ? createWorkersMailgunQueue({
      apiKey: mailgunApiKey,
      domain: mailgunDomain,
    })
    : createNoopQueue()
  // DB is created per request — Workers forbid reusing I/O across fetch handlers.
  cachedApp = createApp({
    emailQueue: cachedEmailQueue,
    secrets: cachedSecrets,
    runtime: 'workers',
    corsOrigins: env.TURBOPANEL_CORS_ORIGINS,
    signupEnvOverride: env.TURBOPANEL_IS_SIGNUP_ENABLED,
    emailFrom: env.TURBOPANEL_SYSTEM_EMAIL_FROM ?? 'noreply@turbopanel.local',
  })
  registerDeveloperRoutesCore(cachedApp as unknown as HonoType, {
    secrets: cachedSecrets,
    authRequired: false,
  })
  registerWorkersDaemonWebSocket(cachedApp as unknown as HonoType)
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    if (!initPromise) initPromise = initWorkerApp(env)
    await initPromise

    const postgresConnectionString = env.HYPERDRIVE?.connectionString
      ?? env.TURBOPANEL_DATABASE_URL?.trim()
      ?? undefined
    const db = env.HYPERDRIVE ? createWorkersDb(env.HYPERDRIVE) : undefined
    const requestApp = new Hono<AppEnv>()
    requestApp.use('*', async (c, next) => {
      if (db) c.set('db', db)
      if (cachedEmailQueue) c.set('emailQueue', cachedEmailQueue)
      if (postgresConnectionString) {
        c.set('postgresConnectionString', postgresConnectionString)
      }
      await next()
    })
    requestApp.route('/', cachedApp!)

    return requestApp.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
