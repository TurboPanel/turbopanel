import { Hono } from 'hono'
import type { SessionData } from './auth/session-store.ts'
import { registerAdminRoutes } from './admin-routes.ts'
import { registerClientRoutes } from './client-routes.ts'
import { registerDaemonApiRoutes } from './daemon-api-routes.ts'
import type { Db } from './db.ts'
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
    sessionSecret,
    runtime,
  }: {
    db?: Db
    sessionSecret?: string
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
  const routes = app as unknown as Hono
  registerClientRoutes(routes, {
    sessionSecret: sessionSecret ?? '',
    runtime: runtime ?? 'workers',
  })
  registerAdminRoutes(routes, { sessionSecret: sessionSecret ?? '' })
  registerDaemonApiRoutes(routes)
  return app
}
