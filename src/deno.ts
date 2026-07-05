import type { Hono } from 'hono'
import { configurePbkdf2Iterations } from './client/authn/password.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from './client/authn/secrets.ts'
import { createApp } from './app.ts'
import { createDenoDb } from './db.ts'
import { logInfo, logWarn } from './logger.ts'
import { createRedisDaemonCellRegistry } from './daemon/cell/redis/registry.ts'
import { sweepStalePresence } from './daemon/cell/control-plane-monitor.ts'
import { DAEMON_CELL_MAINTAIN_MS } from './daemon/cell/protocol.ts'
import {
  ensureColocatedLicenseCredentialsOnDisk,
} from './client/authn/install-state.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { registerInstallRoutes } from './lib/install/routes.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { registerDaemonWebSocket } from './daemon/deno-ws.ts'
import { registerVersionRoute } from './daemon/version.ts'
import { registerSystemRoutes } from './developer/system-routes.ts'
import { registerDevSyncRoutes } from './developer/dev-sync.ts'
import { registerTunnelRoutes } from './developer/tunnel-routes.ts'
import { registerUpdateRoutes } from './developer/update-routes.ts'
import { registerDeveloperRoutes } from './developer/routes.ts'
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
configurePbkdf2Iterations(Deno.env.get('TURBOPANEL_PBKDF2_ITERATIONS'))

const developerSurface = isDeveloperSurfaceEnabled()
const db = createDenoDb()

async function resolveEmailQueue(_db: Db): Promise<EmailQueue> {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl !== undefined && envUrl.trim() === '') {
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
  if (envUrl !== undefined && envUrl.trim() === '') {
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

const emailQueue = await resolveEmailQueue(db)
const commandQueue = await resolveCommandQueue()

function resolveCommandAmqpUrl(): string | null {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl !== undefined && envUrl.trim() === '') {
    return null
  }
  if (envUrl !== undefined) {
    return envUrl.trim()
  }
  return DEFAULT_AMQP_URL
}
const runtimeEnv = Deno.env.toObject()
const emailSettings = await resolveEmailSettings(db, runtimeEnv)
const secretsConfig = parseSecretsEnv(
  Deno.env.get('TURBOPANEL_SECRET'),
  Deno.env.get('TURBOPANEL_SECRETS'),
  'deno',
)
const sessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
const daemonJwtSecrets = await deriveSecretsConfig(secretsConfig, 'daemon-jwt-signing')
const challengeSigningSecrets = await deriveSecretsConfig(secretsConfig, 'daemon-challenge-signing')
const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(secretsConfig, 'data-encryption')
const daemonCellRegistry = createRedisDaemonCellRegistry({ db })
const queryCache = createRedisQueryCache({ client: daemonCellRegistry.client, db })

let commandConsumer: { close(): Promise<void> } | null = null
if (!isNoopCommandQueue(commandQueue)) {
  const amqpUrl = resolveCommandAmqpUrl()
  if (amqpUrl) {
    void startCommandConsumer({
      db,
      registry: daemonCellRegistry,
      amqpUrl,
    })
      .then((consumer) => {
        commandConsumer = consumer
      })
      .catch((err) => {
        logWarn(
          'command-consumer',
          `AMQP broker unavailable; command consumer not started: ${String(err)}`,
        )
      })
  }
} else {
  logWarn('command-consumer', 'AMQP broker unavailable; command consumer not started')
}

const app = createApp({
  db,
  emailQueue,
  commandQueue,
  secrets: sessionSecrets,
  runtime: 'deno',
  corsOrigins: Deno.env.get('TURBOPANEL_UI_CORS_ORIGINS'),
  signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
  emailFrom: emailSettings.from,
  baseUrl: Deno.env.get('TURBOPANEL_BASE_URL') ?? undefined,
  daemonCellRegistry,
  queryCache,
  dataEncryptionSecrets,
  secretsConfig,
})
const routes = app as unknown as Hono
routes.use('*', (c, next) => {
  c.set('platformEnv', Deno.env.toObject())
  return next()
})
registerInstallRoutes(routes, {
  secrets: sessionSecrets,
  runtime: 'deno',
  signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
})
if (developerSurface) {
  registerDeveloperRoutes(routes, { secrets: sessionSecrets, db })
}
registerDaemonApiRoutes(routes, {
  secrets: daemonJwtSecrets,
  challengeSigningSecrets,
  secretsConfig,
})
registerVersionRoute(routes)
if (developerSurface) {
  registerSystemRoutes(routes, { secrets: sessionSecrets, db })
  registerDevSyncRoutes(routes, { secrets: sessionSecrets })
  registerTunnelRoutes(routes, { secrets: sessionSecrets })
  registerUpdateRoutes(routes, { secrets: sessionSecrets })
}
registerDaemonWebSocket(routes, {
  developerSurface,
  db,
  secrets: daemonJwtSecrets,
  daemonCellRegistry,
})
registerAdminRoutes(routes, {
  secrets: sessionSecrets,
  runtime: 'deno',
  devSurface: developerSurface,
})
const socketPath = resolveInstanceSocket()

const abort = new AbortController()
// Deno process timer (not a Durable Object) — cost-safe. maintain() is the Redis
// equivalent of the DO alarm() stale sweep; sweepStalePresence mirrors offline
// demotion. Liveness uses Redis key TTLs (registry.maintain) rather than WS auto-response.
const maintenanceTimer = setInterval(() => {
  void daemonCellRegistry.maintain().catch((err) => {
    logWarn('daemon-cell', `maintenance error: ${String(err)}`)
  })
  void sweepStalePresence(db, daemonCellRegistry).catch((err) => {
    logWarn('daemon-cell', `stale presence sweep error: ${String(err)}`)
  })
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

void ensureColocatedLicenseCredentialsOnDisk(db).catch((err) => {
  logInfo('install', `license credential recovery skipped: ${String(err)}`)
})

Deno.serve({
  path: socketPath,
  signal: abort.signal,
  async onListen({ path }) {
    await hardenInstanceSocket(path)
    logInfo(
      'instance',
      `TurboPanel listening on ${path}; developer surface ${
        developerSurface ? 'enabled' : 'disabled'
      }`,
    )
  },
}, app.fetch)
