import type { Hono } from 'hono'
import { deriveSecretsConfig, parseSecretsEnv } from './client/authn/secrets.ts'
import { createApp } from './app.ts'
import { createDenoDb } from './db.ts'
import { logInfo } from './logger.ts'
import { createRedisChallengeStore } from './daemon/cell/challenge-store.ts'
import { createRedisDaemonCellRegistry } from './daemon/cell/redis/registry.ts'
import { DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS } from './daemon/authn/challenge.ts'
import { DAEMON_PING_MS } from './daemon/cell/protocol.ts'
import {
  ensureColocatedLicenseCredentialsOnDisk,
} from './client/authn/install-state.ts'
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
import { createNoopQueue } from './lib/email/noop-queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import {
  hardenInstanceSocket,
  prepareInstanceSocket,
  resolveInstanceSocket,
} from './server-paths.ts'
const developerSurface = isDeveloperSurfaceEnabled()
const db = createDenoDb()

async function resolveEmailQueue(): Promise<EmailQueue> {
  const envUrl = Deno.env.get('TURBOPANEL_AMQP_URL')
  if (envUrl !== undefined && envUrl.trim() === '') {
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

const emailQueue = await resolveEmailQueue()
const secretsConfig = parseSecretsEnv(
  Deno.env.get('TURBOPANEL_SECRET'),
  Deno.env.get('TURBOPANEL_SECRETS'),
  'deno',
)
const sessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
const daemonJwtSecrets = await deriveSecretsConfig(secretsConfig, 'daemon-jwt-signing')
const daemonCellRegistry = createRedisDaemonCellRegistry()
const challengeStoreProvider = {
  enroll: createRedisChallengeStore(
    daemonCellRegistry.client,
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
  ),
  auth: createRedisChallengeStore(
    daemonCellRegistry.client,
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
  ),
}
const app = createApp({
  db,
  emailQueue,
  secrets: sessionSecrets,
  runtime: 'deno',
  corsOrigins: Deno.env.get('TURBOPANEL_UI_CORS_ORIGINS'),
  signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
  emailFrom: Deno.env.get('TURBOPANEL_SYSTEM_EMAIL_FROM') ?? 'noreply@turbopanel.local',
  baseUrl: Deno.env.get('TURBOPANEL_BASE_URL') ?? undefined,
  daemonCellRegistry,
})
const routes = app as unknown as Hono
registerInstallRoutes(routes, {
  secrets: sessionSecrets,
  runtime: 'deno',
  signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
})
if (developerSurface) {
  registerDeveloperRoutes(routes, { secrets: sessionSecrets, db, authRequired: false })
}
registerDaemonApiRoutes(routes, {
  secrets: daemonJwtSecrets,
  challengeStoreProvider,
})
registerVersionRoute(routes)
if (developerSurface) {
  registerSystemRoutes(routes, { secrets: sessionSecrets, db, authRequired: false })
  registerDevSyncRoutes(routes, { secrets: sessionSecrets, authRequired: false })
  registerTunnelRoutes(routes, { secrets: sessionSecrets, authRequired: false })
  registerUpdateRoutes(routes, { secrets: sessionSecrets, authRequired: false })
}
registerDaemonWebSocket(routes, {
  developerSurface,
  db,
  secrets: daemonJwtSecrets,
  daemonCellRegistry,
})
const socketPath = resolveInstanceSocket()

const abort = new AbortController()
const maintenanceTimer = setInterval(() => {
  void daemonCellRegistry.maintain().catch((err) => {
    logInfo('daemon-cell', `maintenance error: ${String(err)}`)
  })
}, DAEMON_PING_MS)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, async () => {
    clearInterval(maintenanceTimer)
    await emailQueue.close?.()
    await daemonCellRegistry.close()
    abort.abort()
  })
}

await prepareInstanceSocket(socketPath)

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
