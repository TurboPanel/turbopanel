import { Hono } from 'hono'
import type { SessionData } from './auth/session-store.ts'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import { registerAdminRoutes } from './admin-routes.ts'
import { registerClientRoutes } from './client-routes.ts'
import { registerDaemonApiRoutes } from './daemon-api-routes.ts'
import type { Db } from './db.ts'
import { getOpenApiSpec } from './openapi.ts'
import { buildScalarHtml } from './scalar-html.ts'
import { HEALTH_PATH } from './surfaces.ts'

export type AppEnv = {
  Variables: {
    db?: Db
    session?: SessionData
  }
}

export function createApp(
  {
    db,
    secrets,
    runtime,
  }: {
    db?: Db
    secrets?: DerivedSecretsConfig
    runtime?: 'deno' | 'workers'
  } = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  if (db) {
    app.use('*', async (c, next) => {
      c.set('db', db)
      await next()
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
  if (secrets) {
    registerClientRoutes(routes, {
      secrets,
      runtime: runtime ?? 'workers',
    })
    registerAdminRoutes(routes, { secrets })
  }
  registerDaemonApiRoutes(routes)
  return app
}
