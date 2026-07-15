import { Hono } from 'hono'
import type { SessionData } from './client/authn/session-store.ts'
import type { DerivedSecretsConfig, SecretsConfig } from './client/authn/secrets.ts'
import { registerClientRoutes } from './client/routes.ts'
import { registerCorsMiddleware } from './cors.ts'
import type { DaemonCellRegistry } from './daemon/cell/contracts.ts'
import type { ServerMetricsStore } from './daemon/metrics/types.ts'
import type { Db } from './db.ts'
import type { SignupEnvOverride } from './client/authn/install-state.ts'
import type { CommandQueue } from './lib/commands/queue.ts'
import type { EmailQueue } from './lib/email/types.ts'
import type { QueryCache } from './query-cache/contracts.ts'
import { HEALTH_PATH } from './surfaces.ts'

export type AppEnv = {
  Variables: {
    db?: Db
    emailQueue?: EmailQueue
    commandQueue?: CommandQueue
    emailFrom?: string
    baseUrl?: string
    session?: SessionData
    /** Hyperdrive or TURBOPANEL_DATABASE_URL for database status routes (Workers). */
    postgresConnectionString?: string
    daemonCellRegistry?: DaemonCellRegistry
    queryCache?: QueryCache
    /**
     * Host server-metrics store (query path). Server metrics are on by default;
     * this stays unset when no storage backend is configured for the runtime.
     */
    serverMetricsStore?: ServerMetricsStore
    /** Platform env bindings for settings resolution (Workers per-request; Deno process env). */
    platformEnv?: Record<string, string | undefined>
    /** AES-GCM data encryption keys (client routes encrypt only). */
    dataEncryptionSecrets?: DerivedSecretsConfig
    /** Root secret config for per-daemon recipient sealing. */
    secretsConfig?: SecretsConfig
  }
}

export function createApp(
  {
    db,
    emailQueue,
    commandQueue,
    emailFrom,
    baseUrl,
    secrets,
    runtime,
    corsOrigins,
    signupEnvOverride,
    daemonCellRegistry,
    queryCache,
    serverMetricsStore,
    dataEncryptionSecrets,
    secretsConfig,
  }: {
    db?: Db
    emailQueue?: EmailQueue
    commandQueue?: CommandQueue
    emailFrom?: string
    baseUrl?: string
    secrets?: DerivedSecretsConfig
    runtime?: 'deno' | 'workers'
    corsOrigins?: string
    signupEnvOverride: SignupEnvOverride | undefined
    daemonCellRegistry?: DaemonCellRegistry
    queryCache?: QueryCache
    serverMetricsStore?: ServerMetricsStore
    dataEncryptionSecrets?: DerivedSecretsConfig
    secretsConfig?: SecretsConfig
  } = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerCorsMiddleware(app, corsOrigins)
  if (db) {
    app.use('*', (c, next) => {
      c.set('db', db)
      return next()
    })
  }
  if (daemonCellRegistry) {
    app.use('*', (c, next) => {
      c.set('daemonCellRegistry', daemonCellRegistry)
      return next()
    })
  }
  if (queryCache) {
    app.use('*', (c, next) => {
      c.set('queryCache', queryCache)
      return next()
    })
  }
  if (serverMetricsStore) {
    app.use('*', (c, next) => {
      c.set('serverMetricsStore', serverMetricsStore)
      return next()
    })
  }
  if (emailQueue) {
    app.use('*', (c, next) => {
      c.set('emailQueue', emailQueue)
      return next()
    })
  }
  if (commandQueue) {
    app.use('*', (c, next) => {
      c.set('commandQueue', commandQueue)
      return next()
    })
  }
  if (emailFrom || baseUrl) {
    app.use('*', (c, next) => {
      if (emailFrom) c.set('emailFrom', emailFrom)
      if (baseUrl) c.set('baseUrl', baseUrl)
      return next()
    })
  }
  if (dataEncryptionSecrets) {
    app.use('*', (c, next) => {
      c.set('dataEncryptionSecrets', dataEncryptionSecrets)
      return next()
    })
  }
  if (secretsConfig) {
    app.use('*', (c, next) => {
      c.set('secretsConfig', secretsConfig)
      return next()
    })
  }
  app.get('/', (c) => c.text('TurboPanel'))
  app.get(HEALTH_PATH, (c) => c.json({ ok: true }))
  if (secrets) {
    registerClientRoutes(app, {
      secrets,
      runtime: runtime ?? 'workers',
      signupEnvOverride,
      emailFrom,
      baseUrl,
    })
  }
  return app
}
