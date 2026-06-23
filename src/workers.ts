import { Hono } from 'hono'
import type { DerivedSecretsConfig } from './client/authn/secrets.ts'
import { configurePbkdf2Iterations } from './client/authn/password.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './client/authn/secrets.ts'
import { createApp, type AppEnv } from './app'
import { createDurableObjectDaemonCellRegistry } from './daemon/cell/do-registry.ts'
import { createDurableObjectChallengeStore } from './daemon/cell/challenge-store.ts'
import { registerDaemonApiRoutes } from './daemon/api-routes.ts'
import { createWorkersDb, type DaemonChallengeStoreProvider } from './db'
import { registerWorkersDaemonWebSocket } from './daemon/workers-ws.ts'
import { DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS } from './daemon/authn/challenge.ts'
import { DAEMON_PING_MS } from './daemon/cell/protocol.ts'
import { createNoopQueue } from './lib/email/noop-queue.ts'
import { createWorkersMailgunQueue } from './lib/email/mailgun/workers-queue.ts'
import type { EmailQueue } from './lib/email/types.ts'

export { DaemonCellObject } from './daemon/cell/do.ts'

let initPromise: Promise<void> | null = null
let cachedApp: ReturnType<typeof createApp> | null = null
let cachedSessionSecrets: DerivedSecretsConfig | null = null
let cachedDaemonJwtSecrets: DerivedSecretsConfig | null = null
let cachedEmailQueue: EmailQueue | null = null
let cachedDaemonCellRegistryFactory:
  | ((env: CloudflareBindings, db?: ReturnType<typeof createWorkersDb>) =>
    ReturnType<typeof createDurableObjectDaemonCellRegistry>)
  | null = null
let lastControlPlaneMaintenanceAt = 0

function createWorkersChallengeStoreProvider(
  env: CloudflareBindings,
): DaemonChallengeStoreProvider {
  const challengeStub = env.DAEMON_CELL.getByName('challenge-store')
  return {
    enroll: createDurableObjectChallengeStore(
      challengeStub,
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    ),
    auth: createDurableObjectChallengeStore(
      challengeStub,
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    ),
  }
}

async function initWorkerApp(env: CloudflareBindings) {
  configurePbkdf2Iterations(env.TURBOPANEL_PBKDF2_ITERATIONS)
  const secretsConfig = parseSecretsEnv(
    env.TURBOPANEL_SECRET,
    env.TURBOPANEL_SECRETS,
    'workers',
  )
  cachedSessionSecrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  cachedDaemonJwtSecrets = await deriveSecretsConfig(secretsConfig, 'daemon-jwt-signing')
  const mailgunApiKey = env.TURBOPANEL_MAILGUN_API_KEY?.trim() ?? ''
  const mailgunDomain = env.TURBOPANEL_MAILGUN_DOMAIN?.trim() ?? ''
  cachedEmailQueue = mailgunApiKey !== '' && mailgunDomain !== ''
    ? createWorkersMailgunQueue({
      apiKey: mailgunApiKey,
      domain: mailgunDomain,
    })
    : createNoopQueue()
  // DB and DO challenge stubs are created per request — Workers forbid reusing I/O
  // objects across fetch handlers.
  cachedApp = createApp({
    emailQueue: cachedEmailQueue,
    secrets: cachedSessionSecrets,
    runtime: 'workers',
    corsOrigins: env.TURBOPANEL_UI_CORS_ORIGINS,
    signupEnvOverride: env.TURBOPANEL_IS_SIGNUP_ENABLED,
    emailFrom: env.TURBOPANEL_SYSTEM_EMAIL_FROM ?? 'noreply@turbopanel.local',
  })
  registerDaemonApiRoutes(cachedApp, {
    secrets: cachedDaemonJwtSecrets ?? undefined,
  })
  registerWorkersDaemonWebSocket(cachedApp, {
    secrets: cachedDaemonJwtSecrets ?? undefined,
  })
  cachedDaemonCellRegistryFactory = (env, db) =>
    createDurableObjectDaemonCellRegistry(env, db)
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
      if (cachedDaemonCellRegistryFactory) {
        const registry = cachedDaemonCellRegistryFactory(env, db)
        c.set('daemonCellRegistry', registry)
        if (db && 'maintain' in registry) {
          const now = Date.now()
          if (now - lastControlPlaneMaintenanceAt >= DAEMON_PING_MS) {
            lastControlPlaneMaintenanceAt = now
            ctx.waitUntil(
              registry.maintain(db).catch((err) => {
                console.error('control-plane maintenance error:', err)
              }),
            )
          }
        }
      }
      c.set('challengeStoreProvider', createWorkersChallengeStoreProvider(env))
      await next()
    })
    requestApp.route('/', cachedApp!)

    return requestApp.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<CloudflareBindings>
