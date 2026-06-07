import { Hono } from 'hono'
import { registerClientRoutes } from './client-routes.ts'
import { registerDaemonApiRoutes } from './daemon-api-routes.ts'
import { registerDeveloperRoutes } from './developer-routes.ts'
import { HEALTH_PATH } from './surfaces.ts'

export function createApp(
  { developerSurface = false }: { developerSurface?: boolean } = {},
) {
  const app = new Hono()
  app.get('/', (c) => c.text('TurboPanel'))
  app.get(HEALTH_PATH, (c) => c.json({ ok: true }))
  registerClientRoutes(app)
  registerDaemonApiRoutes(app)
  if (developerSurface) registerDeveloperRoutes(app)
  return app
}
