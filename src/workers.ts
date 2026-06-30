import { Hono } from 'hono'
import type { DerivedSecretsConfig } from './client/authn/secrets.ts'
import { configurePbkdf2Iterations } from './client/authn/password.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './client/authn/secrets.ts'
import { createApp, type AppEnv } from './app'
import { createDurableObjectDaemonCellRegistry } from './daemon/cell/do-registry.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { createWorkersDb } from './db'
import { registerWorkersDaemonWebSocket } from './daemon/workers-ws.ts'
import { resolveWorkersEmailQueue } from './lib/email/mailgun/workers-queue.ts'
import {
  resolveEmailSettings,
} from './lib/settings/email-settings.ts'
import { createWorkersCommandQueue } from './lib/commands/workers-queue.ts'
import { createNoopCommandQueue } from './lib/commands/noop-command-queue.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import { isTransientError, processCommandEnvelope } from './lib/commands/consumer.ts'
import { parseCommandEnvelope } from './lib/commands/envelope.ts'
import type { EmailQueue } from './lib/email/types.ts'

export { DaemonCellObject } from './daemon/cell/do.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSessionSecrets: DerivedSecretsConfig | null = null
let cachedDaemonJwtSecrets: DerivedSecretsConfig | null = null
let cachedChallengeSigningSecrets: DerivedSecretsConfig | null = null
let cachedEmailQueue: EmailQueue | null = null
let cachedCommandQueue: CommandQueue | null = null
let cachedDaemonCellRegistryFactory:
  | ((env: CloudflareBindings, db?: ReturnType<typeof createWorkersDb>) =>
    ReturnType<typeof createDurableObjectDaemonCellRegistry>)
  | null = null

async function initWorkerApp(env: CloudflareBindings) {
  configurePbkdf2Iterations(env.TURBOPANEL_PBKDF2_ITERATIONS)
  const secretsConfig = parseSecretsEnv(
    env.TURBOPANEL_SECRET,
    env.TURBOPANEL_SECRETS,
    'workers',
  )
  cachedSessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  cachedDaemonJwtSecrets = await deriveSecretsConfig(secretsConfig, 'daemon-jwt-signing')
  cachedChallengeSigningSecrets = await deriveSecretsConfig(secretsConfig, 'daemon-challenge-signing')
  const platformEnv = stringBindingEnv(env)
  const db = resolveWorkersDb(env)
  // Workers Mailgun path sends directly (no AMQP/RabbitMQ). Cloudflare Workers provides
  // its own concurrency, retries, and queueing at the platform level, so the instance
  // enqueues to Mailgun immediately via resolveWorkersEmailQueue -> WorkersMailgunQueue.
  cachedEmailQueue = await resolveWorkersEmailQueue(db, platformEnv)
  cachedCommandQueue = env.TURBOPANEL_COMMAND_QUEUE
    ? createWorkersCommandQueue(env.TURBOPANEL_COMMAND_QUEUE)
    : createNoopCommandQueue()
  const emailSettings = await resolveEmailSettings(db, platformEnv)
  // DB is created per request — Workers forbid reusing I/O objects across fetch handlers.
  cachedApp = createApp({
    emailQueue: cachedEmailQueue,
    commandQueue: cachedCommandQueue,
    secrets: cachedSessionSecrets,
    runtime: 'workers',
    corsOrigins: env.TURBOPANEL_UI_CORS_ORIGINS,
    signupEnvOverride: env.TURBOPANEL_IS_SIGNUP_ENABLED,
    emailFrom: emailSettings.from,
  })
  registerDaemonApiRoutes(cachedApp, {
    secrets: cachedDaemonJwtSecrets ?? undefined,
    challengeSigningSecrets: cachedChallengeSigningSecrets ?? undefined,
  })
  registerWorkersDaemonWebSocket(cachedApp, {
    secrets: cachedDaemonJwtSecrets ?? undefined,
  })
  registerAdminRoutes(cachedApp, {
    secrets: cachedSessionSecrets!,
    runtime: 'workers',
    devSurface: isWorkersDevSurface(env),
  })
  cachedDaemonCellRegistryFactory = (env, db) =>
    createDurableObjectDaemonCellRegistry(env, db)
}

function isWorkersDevSurface(env: CloudflareBindings): boolean {
  const flag = env.TURBOPANEL_DEV_SURFACE?.trim().toLowerCase()
  return flag === '1' || flag === 'true'
}

function resolveWorkersDb(env: CloudflareBindings): ReturnType<typeof createWorkersDb> | undefined {
  if (env.HYPERDRIVE) {
    return createWorkersDb(env.HYPERDRIVE)
  }
  const databaseUrl = env.TURBOPANEL_DATABASE_URL?.trim()
  if (databaseUrl) {
    return createWorkersDb({ connectionString: databaseUrl })
  }
  return undefined
}

function stringBindingEnv(env: CloudflareBindings): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    if (!initPromise) initPromise = initWorkerApp(env)
    await initPromise

    const postgresConnectionString = env.HYPERDRIVE?.connectionString
      ?? env.TURBOPANEL_DATABASE_URL?.trim()
      ?? undefined
    const db = resolveWorkersDb(env)
    const requestApp = new Hono<AppEnv>()
    requestApp.use('*', async (c, next) => {
      if (db) c.set('db', db)
      if (cachedEmailQueue) c.set('emailQueue', cachedEmailQueue)
      if (cachedCommandQueue) c.set('commandQueue', cachedCommandQueue)
      c.set('platformEnv', stringBindingEnv(env))
      if (postgresConnectionString) {
        c.set('postgresConnectionString', postgresConnectionString)
      }
      if (cachedDaemonCellRegistryFactory) {
        const registry = cachedDaemonCellRegistryFactory(env, db)
        c.set('daemonCellRegistry', registry)
      }
      await next()
    })
    requestApp.route('/', cachedApp!)

    return requestApp.fetch(request, env, ctx)
  },

  async queue(batch: MessageBatch<unknown>, env: CloudflareBindings) {
    if (!initPromise) initPromise = initWorkerApp(env)
    await initPromise

    const db = resolveWorkersDb(env)
    if (!db || !cachedDaemonCellRegistryFactory) {
      batch.retryAll()
      return
    }

    const registry = cachedDaemonCellRegistryFactory(env, db)

    try {
      for (const msg of batch.messages) {
        try {
          const envelope = parseCommandEnvelope(msg.body)
          await processCommandEnvelope(db, registry, envelope)
          msg.ack()
        } catch (error) {
          if (isTransientError(error)) {
            msg.retry()
          } else {
            msg.ack()
          }
        }
      }
    } catch {
      batch.retryAll()
    }
  },
} satisfies ExportedHandler<CloudflareBindings>
