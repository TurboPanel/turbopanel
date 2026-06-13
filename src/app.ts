import { Hono } from 'hono'
import type { SessionData } from './auth/session-store.ts'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import { registerAdminRoutes } from './admin-routes.ts'
import { registerClientRoutes } from './client-routes.ts'
import { registerInstallRoutes } from './install-routes.ts'
import { registerDaemonApiRoutes } from './daemon-api-routes.ts'
import { registerCorsMiddleware } from './cors.ts'
import type { Db } from './db.ts'
import type { EmailQueue } from './email/types.ts'
import { getOpenApiSpec } from './openapi.ts'
import { buildScalarHtml } from './scalar-html.ts'
import { HEALTH_PATH } from './surfaces.ts'

export type AppEnv = {
  Variables: {
    db?: Db
    emailQueue?: EmailQueue
    emailFrom?: string
    baseUrl?: string
    session?: SessionData
  }
}

export function createApp(
  {
    db,
    emailQueue,
    emailFrom,
    baseUrl,
    secrets,
    runtime,
    corsOrigins,
    signupEnvOverride,
  }: {
    db?: Db
    emailQueue?: EmailQueue
    emailFrom?: string
    baseUrl?: string
    secrets?: DerivedSecretsConfig
    runtime?: 'deno' | 'workers'
    corsOrigins?: string
    signupEnvOverride?: string
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
  if (emailQueue) {
    app.use('*', (c, next) => {
      c.set('emailQueue', emailQueue)
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
  app.get('/api/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json(getOpenApiSpec(origin))
  })
  app.get('/api/reference', (c) => {
    const origin = new URL(c.req.url).origin
    return c.html(buildScalarHtml('/api/openapi.json', origin))
  })
  const routes = app as unknown as Hono
  registerInstallRoutes(routes, {
    secrets: secrets ?? undefined,
    runtime: runtime ?? 'workers',
    signupEnvOverride,
  })
  if (secrets) {
    registerClientRoutes(routes, {
      secrets,
      runtime: runtime ?? 'workers',
      signupEnvOverride,
      emailFrom,
      baseUrl,
    })
    registerAdminRoutes(routes, { secrets })
  }
  registerDaemonApiRoutes(routes)
  return app
}
