import type { Hono } from 'hono'
import { deriveSecretsConfig, parseSecretsEnv } from './auth/secrets.ts'
import { createApp } from './app.ts'
import { createDenoDb } from './db.ts'
import { ensureDbSchemaReady } from './db/schema-push.ts'
import { logInfo } from './logger.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { registerVersionRoute } from './daemon-version.ts'
import { registerSystemRoutes } from './system-routes.ts'
import { registerDevSyncRoutes } from './dev-sync.ts'
import { registerTunnelRoutes } from './tunnel-routes.ts'
import { registerUpdateRoutes } from './update-routes.ts'
import { registerDeveloperRoutes } from './developer-routes.ts'
import { isDeveloperSurfaceEnabled } from './dev-mode.ts'
import {
  createDenoAmqpQueue,
  DEFAULT_AMQP_URL,
  probeAmqpBrokerReachable,
} from './email/deno-amqp-queue.ts'
import { createNoopQueue } from './email/noop-queue.ts'
import type { EmailQueue } from './email/types.ts'
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
await ensureDbSchemaReady(db)
const secretsConfig = parseSecretsEnv(
  Deno.env.get('TURBOPANEL_SECRET'),
  Deno.env.get('TURBOPANEL_SECRETS'),
  'deno',
)
const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
const app = createApp({
  db,
  emailQueue,
  secrets,
  runtime: 'deno',
  corsOrigins: Deno.env.get('TURBOPANEL_CORS_ORIGINS'),
  signupEnvOverride: Deno.env.get('TURBOPANEL_IS_SIGNUP_ENABLED'),
  emailFrom: Deno.env.get('TURBOPANEL_SYSTEM_EMAIL_FROM') ?? 'noreply@turbopanel.local',
  baseUrl: Deno.env.get('TURBOPANEL_BASE_URL') ?? undefined,
})
const routes = app as unknown as Hono
if (developerSurface) {
  registerDeveloperRoutes(routes, { secrets, db, authRequired: false })
}
registerVersionRoute(routes)
if (developerSurface) {
  registerSystemRoutes(routes, { secrets, db, authRequired: false })
  registerDevSyncRoutes(routes, { secrets, authRequired: false })
  registerTunnelRoutes(routes, { secrets, authRequired: false })
  registerUpdateRoutes(routes, { secrets, authRequired: false })
}
registerDaemonWebSocket(routes, { developerSurface, db, secrets })
const socketPath = resolveInstanceSocket()

const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, async () => {
    await emailQueue.close?.()
    abort.abort()
  })
}

await prepareInstanceSocket(socketPath)

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
