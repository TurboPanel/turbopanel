import type { Hono } from 'hono'
import {
  deriveDaemonJwtKeyring,
} from './daemon/authn/daemon-jwt-keyring.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
  type DerivedSecretsConfig,
} from './client/authn/secrets.ts'
import { createApp } from './app.ts'
import { createDenoDb } from './db.ts'
import { logInfo, logWarn } from './logger.ts'
import { createRedisDaemonCellRegistry } from './daemon/cell/redis/registry.ts'
import { sweepStalePresence } from './daemon/cell/control-plane-monitor.ts'
import { DAEMON_CELL_MAINTAIN_MS } from './daemon/cell/protocol.ts'
import { runSystemReconcileSweep } from './client/system/reconcile.ts'
import {
  assertPasswordHasherAvailable,
  configureArgon2idWorkFactor,
} from './client/authn/password.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { registerInstallRoutes } from './lib/install/routes.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { registerDaemonWebSocket } from './daemon/deno-ws.ts'
import {
  parseMetricsRetentionDays,
  resolveServerMetricsStore,
} from './daemon/metrics/store-selection.ts'
import { setServerStatusEventSink } from './daemon/metrics/status-events.ts'
import {
  createRedisRateLimiter,
  resolveDaemonConnectRateLimit,
  resolveDaemonMetricsRateLimit,
  resolveDaemonRestRateLimit,
  resolveDaemonWsInboundLimits,
} from './daemon/rate-limit/redis-rate-limiter.ts'
import { createDurableAuthRateLimiter } from './client/authn/auth-rate-limit.ts'
import { OTP_VERIFIER_SECRET_PURPOSE } from './client/authn/email-otp.ts'
import { isDeveloperSurfaceEnabled } from './dev-mode.ts'
import {
  createDenoAmqpQueue,
  DEFAULT_AMQP_URL,
  probeAmqpBrokerReachable,
} from './lib/email/smtp/deno-amqp-queue.ts'
import { resolveEmailSettings } from './lib/settings/email-settings.ts'
import { createNoopQueue } from './lib/email/noop-queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import {
  createDenoAmqpCommandQueue,
  probeCommandAmqpBrokerReachable,
} from './lib/commands/deno-amqp-queue.ts'
import { startCommandConsumer } from './lib/commands/deno-consumer.ts'
import {
  createNoopCommandQueue,
  isNoopCommandQueue,
} from './lib/commands/noop-command-queue.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import type { Db } from './db.ts'
import { createRedisQueryCache } from './query-cache/redis-query-cache.ts'
import {
  hardenInstanceSocket,
  prepareInstanceSocket,
  resolveInstanceSocket,
} from './server-paths.ts'

export type DenoDeveloperSurfaceContext = {
  routes: Hono
  sessionSecrets: DerivedSecretsConfig
  db: Db
}

export type StartDenoServerOptions = {
  /**
   * Optional developer-surface registrar. Production `src/deno.ts` omits this
   * so developer modules stay out of the compiled graph. The development
   * entrypoint passes a registrar that imports those modules.
   */
  registerDeveloperSurface?: (ctx: DenoDeveloperSurfaceContext) => void
}

async function resolveEmailQueue(_db: Db): Promise<EmailQueue> {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl?.trim() === '') {
    logInfo('email', 'TURBOPANEL_AMQP_URL is empty; using noop queue')
    return createNoopQueue()
  }
  if (envUrl !== undefined) {
    return createDenoAmqpQueue({ amqpUrl: envUrl.trim() })
  }
  if (await probeAmqpBrokerReachable(DEFAULT_AMQP_URL)) {
    return createDenoAmqpQueue({ amqpUrl: DEFAULT_AMQP_URL })
  }

  logInfo('email', 'AMQP broker unavailable; using noop queue')
  return createNoopQueue()
}

async function resolveCommandQueue(): Promise<CommandQueue> {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl?.trim() === '') {
    return createNoopCommandQueue()
  }
  if (envUrl !== undefined) {
    return createDenoAmqpCommandQueue({ amqpUrl: envUrl.trim() })
  }
  if (await probeCommandAmqpBrokerReachable(DEFAULT_AMQP_URL)) {
    return createDenoAmqpCommandQueue({ amqpUrl: DEFAULT_AMQP_URL })
  }

  logInfo('command-queue', 'AMQP broker unavailable; using noop command queue')
  return createNoopCommandQueue()
}

async function startOptionalCommandConsumer(opts: {
  db: Db
  commandQueue: CommandQueue
  daemonCellRegistry: ReturnType<typeof createRedisDaemonCellRegistry>
  secretsConfig: ReturnType<typeof parseSecretsEnv>
  dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
}): Promise<{ close(): Promise<void> } | null> {
  if (isNoopCommandQueue(opts.commandQueue)) {
    logWarn('command-consumer', 'AMQP broker unavailable; command consumer not started')
    return null
  }
  const amqpUrl = resolveCommandAmqpUrl()
  if (!amqpUrl) return null
  try {
    return await startCommandConsumer({
      db: opts.db,
      registry: opts.daemonCellRegistry,
      amqpUrl,
      commandQueue: opts.commandQueue,
      resealDeps: {
        secretsConfig: opts.secretsConfig,
        dataEncryptionSecrets: opts.dataEncryptionSecrets,
      },
      secretsConfig: opts.secretsConfig,
      dataEncryptionSecrets: opts.dataEncryptionSecrets,
    })
  } catch (err) {
    logWarn(
      'command-consumer',
      `AMQP broker unavailable; command consumer not started: ${String(err)}`,
    )
    return null
  }
}

function resolveCommandAmqpUrl(): string | null {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl?.trim() === '') {
    return null
  }
  if (envUrl !== undefined) {
    return envUrl.trim()
  }
  return DEFAULT_AMQP_URL
}

export async function startDenoServer(
  options: StartDenoServerOptions = {},
): Promise<void> {
  const developerSurface = Boolean(options.registerDeveloperSurface) &&
    isDeveloperSurfaceEnabled()
  const db = createDenoDb()
  const emailQueue = await resolveEmailQueue(db)
  const commandQueue = await resolveCommandQueue()
  const runtimeEnv = Deno.env.toObject()
  configureArgon2idWorkFactor({
    memoryKib: Deno.env.get('TURBOPANEL_ARGON2ID_MEMORY_KIB') ?? null,
    timeCost: Deno.env.get('TURBOPANEL_ARGON2ID_TIME_COST') ?? null,
  })
  await assertPasswordHasherAvailable()
  logInfo('auth', 'Argon2id password hasher available')
  const secretsConfig = parseSecretsEnv(
    Deno.env.get('TURBOPANEL_SECRET'),
    Deno.env.get('TURBOPANEL_SECRETS'),
    'deno',
  )
  const sessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const otpVerifierSecrets = await deriveSecretsConfig(
    secretsConfig,
    OTP_VERIFIER_SECRET_PURPOSE,
  )
  const daemonJwtKeyring = await deriveDaemonJwtKeyring(secretsConfig)
  const challengeSigningSecrets = await deriveSecretsConfig(
    secretsConfig,
    'daemon-challenge-signing',
  )
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  // Derived after data-encryption secrets so DB-backed email secrets can be decrypted.
  const emailSettings = await resolveEmailSettings(db, runtimeEnv, dataEncryptionSecrets)
  const daemonCellRegistry = createRedisDaemonCellRegistry({ db })
  const queryCache = createRedisQueryCache({ client: daemonCellRegistry.client, db })
  const serverMetricsStore = resolveServerMetricsStore({
    runtime: 'deno',
    clickhouse: {
      url: Deno.env.get('TURBOPANEL_CLICKHOUSE_URL'),
      database: Deno.env.get('TURBOPANEL_CLICKHOUSE_DATABASE'),
      user: Deno.env.get('TURBOPANEL_CLICKHOUSE_USER'),
      password: Deno.env.get('TURBOPANEL_CLICKHOUSE_PASSWORD'),
      retentionDays: parseMetricsRetentionDays(
        Deno.env.get('TURBOPANEL_SERVER_METRICS_RETENTION_DAYS'),
      ),
    },
  })
  setServerStatusEventSink(serverMetricsStore)
  const connectRate = resolveDaemonConnectRateLimit()
  const restRate = resolveDaemonRestRateLimit()
  const metricsRate = resolveDaemonMetricsRateLimit()
  const inboundLimits = resolveDaemonWsInboundLimits()
  const daemonConnectLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: connectRate.limit,
    periodSeconds: connectRate.periodSeconds,
  })
  const daemonRestLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: restRate.limit,
    periodSeconds: restRate.periodSeconds,
  })
  const daemonMetricsLimiter = createRedisRateLimiter({
    client: daemonCellRegistry.client,
    limit: metricsRate.limit,
    periodSeconds: metricsRate.periodSeconds,
  })
  // Durable, globally-shared client-auth throttle over Redis (same infrastructure
  // as the daemon limiters). Auth uses onError: 'closed' so a Redis hiccup cannot
  // fail open into unthrottled login/OTP/install; daemon limiters keep the
  // default fail-open behaviour.
  const authRateLimiter = createDurableAuthRateLimiter(
    createRedisRateLimiter({
      client: daemonCellRegistry.client,
      limit: 10,
      periodSeconds: 60,
      onError: 'closed',
    }),
  )

  const commandConsumer = await startOptionalCommandConsumer({
    db,
    commandQueue,
    daemonCellRegistry,
    secretsConfig,
    dataEncryptionSecrets,
  })

  const app = createApp({
    db,
    emailQueue,
    commandQueue,
    secrets: sessionSecrets,
    otpVerifierSecrets,
    runtime: 'deno',
    corsOrigins: Deno.env.get('TURBOPANEL_UI_CORS_ORIGINS'),
    signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
    emailFrom: emailSettings.from,
    baseUrl: Deno.env.get('TURBOPANEL_BASE_URL') ?? undefined,
    daemonCellRegistry,
    queryCache,
    serverMetricsStore,
    dataEncryptionSecrets,
    secretsConfig,
    // Inject before client routes mount — must not be registered after
    // registerClientRoutes (see createApp authRateLimiter middleware).
    authRateLimiter,
  })
  app.use('*', (c, next) => {
    // Deno serves behind the local Caddy → Unix socket, so session-cookie TLS
    // uses the trusted-proxy path that honors X-Forwarded-Proto.
    c.set('runtime', 'deno')
    c.set('platformEnv', Deno.env.toObject())
    return next()
  })
  // Install / daemon registrars still take untyped Hono.
  const routes = app as unknown as Hono
  registerInstallRoutes(routes, {
    secrets: sessionSecrets,
    otpVerifierSecrets,
    runtime: 'deno',
    signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
  })
  if (developerSurface) {
    options.registerDeveloperSurface?.({ routes, sessionSecrets, db })
  }
  registerDaemonApiRoutes(routes, {
    secrets: daemonJwtKeyring,
    challengeSigningSecrets,
    secretsConfig,
    restLimiter: daemonRestLimiter,
    metricsLimiter: daemonMetricsLimiter,
  })
  registerDaemonWebSocket(routes, {
    developerSurface,
    db,
    secrets: daemonJwtKeyring,
    sessionSecrets,
    daemonCellRegistry,
    connectLimiter: daemonConnectLimiter,
    inboundMessageLimit: inboundLimits.limit,
    inboundMessageWindowMs: inboundLimits.windowMs,
  })
  registerAdminRoutes(app, {
    secrets: sessionSecrets,
    runtime: 'deno',
    devSurface: developerSurface,
  })
  const socketPath = resolveInstanceSocket()

  const abort = new AbortController()
  // Deno process timer (not a Durable Object) — cost-safe. Both backends demote
  // stale presence at DAEMON_OFFLINE_SWEEP_MS; Redis uses this timer-driven
  // maintain() + sweepStalePresence loop. Workers is disconnect-first (no periodic
  // DO stale-sweep alarm) — see DaemonCellObject alarm-path comments in do.ts.
  const maintenanceTimer = setInterval(() => {
    void daemonCellRegistry.maintain().catch((err) => {
      logWarn('daemon-cell', `maintenance error: ${String(err)}`)
    })
    void sweepStalePresence(db, daemonCellRegistry).catch((err) => {
      logWarn('daemon-cell', `stale presence sweep error: ${String(err)}`)
    })
    if (!isNoopCommandQueue(commandQueue)) {
      void runSystemReconcileSweep(db, commandQueue).catch((err) => {
        logWarn('daemon-cell', `system reconcile sweep error: ${String(err)}`)
      })
    }
  }, DAEMON_CELL_MAINTAIN_MS)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    Deno.addSignalListener(signal, async () => {
      clearInterval(maintenanceTimer)
      await emailQueue.close?.()
      await commandQueue.close?.()
      await commandConsumer?.close()
      await daemonCellRegistry.close()
      abort.abort()
    })
  }

  await prepareInstanceSocket(socketPath)

  await daemonCellRegistry.reclaimOrphanedSocketLeasesOnStartup()

  Deno.serve({
    path: socketPath,
    signal: abort.signal,
    async onListen(addr) {
      const path = 'path' in addr ? addr.path : socketPath
      await hardenInstanceSocket(path)
      logInfo(
        'instance',
        `TurboPanel listening on ${path}; developer surface ${
          developerSurface ? 'enabled' : 'disabled'
        }`,
      )
    },
  }, app.fetch)
}
