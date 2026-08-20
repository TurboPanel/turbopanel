import { Hono } from 'hono'
import type { DaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import { deriveDaemonJwtKeyring } from './daemon/authn/daemon-jwt-keyring.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsFromEnv,
  type DerivedSecretsConfig,
  type SecretsConfig,
} from './client/authn/secrets.ts'
import { createApp, type AppEnv } from './app.ts'
import { createDurableObjectDaemonCellRegistry } from './daemon/cell/do-registry.ts'
import { runOfflineSweep } from './daemon/cell/offline-sweep.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { registerWorkersDaemonWebSocket } from './daemon/workers-ws.ts'
import { resolveWorkersEmailQueue } from './lib/email/mailgun/workers-queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import { normalizeSignupEnvOverride } from './client/authn/install-state.ts'
import {
  assertPasswordHasherAvailable,
  configureArgon2idWorkFactor,
} from './client/authn/password.ts'
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
import { setServerStatusEventSink } from './daemon/metrics/status-events.ts'
import type { ServerMetricsStore } from './daemon/metrics/types.ts'
import {
  closeWorkersRequestDb,
  openWorkersRequestDb,
  resolveWorkersClientAuthRateLimiter,
  resolveWorkersDaemonRateLimiters,
  resolveWorkersDb,
  warnIfCachedHyperdriveMissing,
  warnIfClientAuthRateLimiterMissing,
  warnIfDaemonRateLimitersMissing,
} from './workers-bindings.ts'
import { endDbConnection, type createWorkersDb } from './db.ts'
import type { AuthRateLimiter } from './client/authn/auth-rate-limit.ts'
import { OTP_VERIFIER_SECRET_PURPOSE } from './client/authn/email-otp.ts'

export { DaemonCellObject } from './daemon/cell/do.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSessionSecrets: Awaited<ReturnType<typeof deriveSecretsConfig>> | null = null
let cachedOtpVerifierSecrets: DerivedSecretsConfig | null = null
let cachedDaemonJwtKeyring: DaemonJwtKeyring | null = null
let cachedChallengeSigningSecrets: DerivedSecretsConfig | null = null
let cachedDataEncryptionSecrets: DerivedSecretsConfig | null = null
let cachedSecretsConfig: SecretsConfig | null = null
let cachedCommandQueue: CommandQueue | null = null
let cachedServerMetricsStore: ServerMetricsStore | null = null
let cachedAuthRateLimiter: AuthRateLimiter | null = null
let cachedDaemonCellRegistryFactory:
  | ((env: CloudflareBindings, db?: ReturnType<typeof createWorkersDb>) =>
    ReturnType<typeof createDurableObjectDaemonCellRegistry>)
  | null = null

/** @internal Clears per-isolate Worker caches so entry tests can re-init. */
export function resetWorkerAppCachesForTests(): void {
  initPromise = null
  cachedApp = null
  cachedSessionSecrets = null
  cachedOtpVerifierSecrets = null
  cachedDaemonJwtKeyring = null
  cachedChallengeSigningSecrets = null
  cachedDataEncryptionSecrets = null
  cachedSecretsConfig = null
  cachedCommandQueue = null
  cachedServerMetricsStore = null
  cachedAuthRateLimiter = null
  cachedDaemonCellRegistryFactory = null
}
async function initWorkerApp(env: CloudflareBindings) {
  const secretsConfig = parseSecretsFromEnv(
    {
      TURBOPANEL_SECRET: env.TURBOPANEL_SECRET,
      TURBOPANEL_SECRETS: env.TURBOPANEL_SECRETS,
    },
    'workers',
  )
  configureArgon2idWorkFactor({
    memoryKib: env.TURBOPANEL_ARGON2ID_MEMORY_KIB,
    timeCost: env.TURBOPANEL_ARGON2ID_TIME_COST,
  })
  await assertPasswordHasherAvailable()
  cachedSecretsConfig = secretsConfig
  cachedSessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  cachedOtpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    OTP_VERIFIER_SECRET_PURPOSE,
  )
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
  setServerStatusEventSink(cachedServerMetricsStore)
  // Email queue + signup force are resolved per request from current env/DB —
  // do not bake them into createApp() so dashboard/panel changes apply without
  // waiting for an isolate recycle. signupEnvOverride here is only a fallback
  // for tests that omit platformEnv.
  cachedApp = createApp({
    commandQueue: cachedCommandQueue,
    secrets: cachedSessionSecrets,
    otpVerifierSecrets: cachedOtpVerifierSecrets ?? undefined,
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
  // Daemon registrars still take untyped Hono (same as deno-server.ts).
  const daemonRoutes = cachedApp as unknown as Hono
  registerDaemonApiRoutes(daemonRoutes, {
    secrets: cachedDaemonJwtKeyring ?? undefined,
    challengeSigningSecrets: cachedChallengeSigningSecrets ?? undefined,
    secretsConfig: cachedSecretsConfig ?? undefined,
    restLimiter: rateLimiters.rest,
    metricsLimiter: rateLimiters.metrics,
  })
  registerWorkersDaemonWebSocket(daemonRoutes, {
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
  // Plain-text dashboard vars are normally strings, but bindings may arrive as
  // numbers/booleans — keep the signup force visible on platformEnv either way.
  const signupForce = normalizeSignupEnvOverride(env.TURBOPANEL_IS_SIGNUP_ENABLED)
  if (signupForce !== undefined) {
    out.TURBOPANEL_IS_SIGNUP_ENABLED = signupForce
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
    // Fresh clients for this invocation only — close in finally via waitUntil
    // so postgres.js pools cannot stack to the 128 MB isolate limit.
    const dbHandles = openWorkersRequestDb(env)
    const { db, queryCache } = dbHandles
    try {
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

      return await requestApp.fetch(request, env, ctx)
    } finally {
      ctx.waitUntil(closeWorkersRequestDb(dbHandles).catch(() => {}))
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: CloudflareBindings,
    ctx: ExecutionContext,
  ) {
    initPromise ??= initWorkerApp(env)
    await initPromise
    ctx.waitUntil(
      runOfflineSweep(
        env,
        cachedSecretsConfig && cachedDataEncryptionSecrets
          ? {
            secretsConfig: cachedSecretsConfig,
            dataEncryptionSecrets: cachedDataEncryptionSecrets,
          }
          : null,
      ),
    )
  },

  async queue(batch: MessageBatch<unknown>, env: CloudflareBindings) {
    initPromise ??= initWorkerApp(env)
    await initPromise

    const db = resolveWorkersDb(env)
    try {
      if (!db || !cachedDaemonCellRegistryFactory) {
        batch.retryAll()
        return
      }

      const registry = cachedDaemonCellRegistryFactory(env, db)

      try {
        for (const msg of batch.messages) {
          try {
            const envelope = parseCommandEnvelope(msg.body)
            await processCommandEnvelope(db, registry, envelope, {
              commandQueue: cachedCommandQueue ?? undefined,
              resealDeps:
                cachedSecretsConfig && cachedDataEncryptionSecrets
                  ? {
                    secretsConfig: cachedSecretsConfig,
                    dataEncryptionSecrets: cachedDataEncryptionSecrets,
                  }
                  : undefined,
              secretsConfig: cachedSecretsConfig ?? undefined,
              dataEncryptionSecrets: cachedDataEncryptionSecrets ?? undefined,
            })
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
    } finally {
      if (db) await endDbConnection(db).catch(() => {})
    }
  },
} satisfies ExportedHandler<CloudflareBindings>
