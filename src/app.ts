import { Hono } from 'hono'
import { registerClientRoutes } from './client-routes.ts'
import { registerDaemonApiRoutes } from './daemon-api-routes.ts'
import { registerDeveloperRoutes } from './developer-routes.ts'
import type { Db } from './db.ts'
import { HEALTH_PATH } from './surfaces.ts'

export type AppEnv = {
  Variables: {
    db?: Db
  }
}

export function createApp(
  { developerSurface = false, db }: { developerSurface?: boolean; db?: Db } = {},
) {
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
  registerClientRoutes(routes)
  registerDaemonApiRoutes(routes)
  if (developerSurface) registerDeveloperRoutes(routes)
  return app
}
