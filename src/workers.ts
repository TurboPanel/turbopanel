import { Hono } from 'hono'
import { configurePbkdf2Iterations } from './client/authn/password.ts'
import type { DaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import { deriveDaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
  type DerivedSecretsConfig,
} from './client/authn/secrets.ts'
import { createApp, type AppEnv } from './app'
import { createDurableObjectDaemonCellRegistry } from './daemon/cell/do-registry.ts'
import { runOfflineSweep } from './daemon/cell/offline-sweep.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { createWorkersDb } from './db'
import { registerWorkersDaemonWebSocket } from './daemon/workers-ws.ts'
import { resolveWorkersEmailQueue } from './lib/email/mailgun/workers-queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import { createWorkersCommandQueue } from './lib/commands/workers-queue.ts'
import { createNoopCommandQueue } from './lib/commands/noop-command-queue.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import { isTransientError, processCommandEnvelope } from './lib/commands/consumer.ts'
import { parseCommandEnvelope } from './lib/commands/envelope.ts'
import {
  resolveAnalyticsEngineSqlConfig,
  resolveServerMetricsStore,
  type AnalyticsEngineDatasetLike,
} from './daemon/metrics/store-selection.ts'
import type { ServerMetricsStore } from './daemon/metrics/types.ts'
import {
  resolveWorkersClientAuthRateLimiter,
  resolveWorkersDaemonRateLimiters,
  resolveWorkersDb,
  resolveWorkersQueryCache,
  warnIfCachedHyperdriveMissing,
  warnIfClientAuthRateLimiterMissing,
  warnIfDaemonRateLimitersMissing,
} from './workers-bindings.ts'
import type { AuthRateLimiter } from './client/authn/auth-rate-limit.ts'

export { DaemonCellObject } from './daemon/cell/do.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSessionSecrets: Awaited<ReturnType<typeof deriveSecretsConfig>> | null = null
let cachedDaemonJwtKeyring: DaemonJwtKeyring | null = null
let cachedChallengeSigningSecrets: DerivedSecretsConfig | null = null
let cachedDataEncryptionSecrets: DerivedSecretsConfig | null = null
let cachedSecretsConfig: ReturnType<typeof parseSecretsEnv> | null = null
let cachedCommandQueue: CommandQueue | null = null
let cachedServerMetricsStore: ServerMetricsStore | null = null
let cachedAuthRateLimiter: AuthRateLimiter | null = null
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
  cachedSecretsConfig = secretsConfig
  cachedSessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  cachedDaemonJwtKeyring = await deriveDaemonJwtKeyring(secretsConfig)
  cachedChallengeSigningSecrets = await deriveSecretsConfig(secretsConfig, 'daemon-challenge-signing')
  cachedDataEncryptionSecrets = await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
  cachedCommandQueue = env.TURBOPANEL_COMMAND_QUEUE
    ? createWorkersCommandQueue(env.TURBOPANEL_COMMAND_QUEUE)
    : createNoopCommandQueue()
  cachedServerMetricsStore = resolveServerMetricsStore({
    runtime: 'workers',
    analyticsEngine: (env as { SERVER_METRICS?: AnalyticsEngineDatasetLike })
      .SERVER_METRICS,
    analyticsEngineSql: resolveAnalyticsEngineSqlConfig(env),
  })
  // Email queue + signup are resolved per request (DB/admin toggles) — do not
  // bake them into createApp() so panel changes apply without a Worker restart.
  // signupEnvOverride remains the optional env *force* only (undefined in live).
  cachedApp = createApp({
    commandQueue: cachedCommandQueue,
    secrets: cachedSessionSecrets,
    runtime: 'workers',
    corsOrigins: env.TURBOPANEL_UI_CORS_ORIGINS,
    signupEnvOverride: env.TURBOPANEL_IS_SIGNUP_ENABLED,
    serverMetricsStore: cachedServerMetricsStore,
    dataEncryptionSecrets: cachedDataEncryptionSecrets ?? undefined,
    secretsConfig: cachedSecretsConfig ?? undefined,
  })
  warnIfDaemonRateLimitersMissing(env)
  warnIfClientAuthRateLimiterMissing(env)
  cachedAuthRateLimiter = resolveWorkersClientAuthRateLimiter(env)
  const rateLimiters = resolveWorkersDaemonRateLimiters(env)
  registerDaemonApiRoutes(cachedApp, {
    secrets: cachedDaemonJwtKeyring ?? undefined,
    challengeSigningSecrets: cachedChallengeSigningSecrets ?? undefined,
    secretsConfig: cachedSecretsConfig ?? undefined,
    restLimiter: rateLimiters.rest,
  })
  registerWorkersDaemonWebSocket(cachedApp, {
    secrets: cachedDaemonJwtKeyring ?? undefined,
    connectLimiter: rateLimiters.connect,
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

function stringBindingEnv(env: CloudflareBindings): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext) {
    initPromise ??= initWorkerApp(env)
    await initPromise

    const postgresConnectionString = env.HYPERDRIVE?.connectionString
      ?? env.TURBOPANEL_DATABASE_URL?.trim()
      ?? undefined
    warnIfCachedHyperdriveMissing(env)
    const db = resolveWorkersDb(env)
    const queryCache = resolveWorkersQueryCache(env, db)
    const platformEnv = stringBindingEnv(env)
    // Resolve email delivery from current DB + platform env on every request so
    // admin PUT /settings/email takes effect without restarting the Worker.
    // (Workers Mailgun sends directly — no AMQP.)
    const emailQueue: EmailQueue = await resolveWorkersEmailQueue(
      db,
      platformEnv,
      cachedDataEncryptionSecrets ?? undefined,
    )
    const requestApp = new Hono<AppEnv>()
    requestApp.use('*', async (c, next) => {
      // Session-cookie TLS uses the URL-derived (Workers) path — a spoofed
      // X-Forwarded-Proto must never downgrade the cookie's Secure flag/name.
      c.set('runtime', 'workers')
      if (db) {
        c.set('db', db)
      }
      if (queryCache) {
        c.set('queryCache', queryCache)
      }
      c.set('emailQueue', emailQueue)
      if (cachedCommandQueue) c.set('commandQueue', cachedCommandQueue)
      if (cachedAuthRateLimiter) c.set('authRateLimiter', cachedAuthRateLimiter)
      c.set('platformEnv', platformEnv)
      if (postgresConnectionString) {
        c.set('postgresConnectionString', postgresConnectionString)
      }
      if (cachedDaemonCellRegistryFactory) {
        const registry = cachedDaemonCellRegistryFactory(env, db)
        c.set('daemonCellRegistry', registry)
      }
      if (cachedServerMetricsStore) {
        c.set('serverMetricsStore', cachedServerMetricsStore)
      }
      await next()
    })
    requestApp.route('/', cachedApp!)

    return requestApp.fetch(request, env, ctx)
  },

  async scheduled(
    controller: ScheduledController,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) {
    initPromise ??= initWorkerApp(env)
    await initPromise
    ctx.waitUntil(runOfflineSweep(env))
  },

  async queue(batch: MessageBatch<unknown>, env: CloudflareBindings) {
    initPromise ??= initWorkerApp(env)
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
