import { Hono } from 'hono'
import type { SessionData } from './client/authn/session-store.ts'
import type { DerivedSecretsConfig } from './client/authn/secrets.ts'
import { registerClientRoutes } from './client/routes.ts'
import { registerCorsMiddleware } from './cors.ts'
import type { DaemonCellRegistry } from './daemon/cell/contracts.ts'
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
    /** Platform env bindings for settings resolution (Workers per-request; Deno process env). */
    platformEnv?: Record<string, string | undefined>
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
  }: {
    db?: Db
    emailQueue?: EmailQueue
    commandQueue?: CommandQueue
    emailFrom?: string
    baseUrl?: string
    secrets?: DerivedSecretsConfig
    runtime?: 'deno' | 'workers'
    corsOrigins?: string
    signupEnvOverride?: SignupEnvOverride
    daemonCellRegistry?: DaemonCellRegistry
    queryCache?: QueryCache
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
  app.get('/', (c) => c.text('TurboPanel'))
  app.get(HEALTH_PATH, (c) => c.json({ ok: true }))
  const routes = app as unknown as Hono
  if (secrets) {
    registerClientRoutes(routes, {
      secrets,
      runtime: runtime ?? 'workers',
      signupEnvOverride,
      emailFrom,
      baseUrl,
    })
  }
  return app
}
