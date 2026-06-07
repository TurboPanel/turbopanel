import { Hono } from 'hono'
import { registerAdminRoutes } from './admin-routes.ts'
import { registerClientRoutes } from './client-routes.ts'
import { registerDaemonApiRoutes } from './daemon-api-routes.ts'
import { HEALTH_PATH } from './surfaces.ts'

export function createApp() {
  const app = new Hono()

  app.get('/', (c) => c.text('TurboPanel'))
  // Single, deliberately-unversioned health probe shared by every surface.
  app.get(HEALTH_PATH, (c) => c.json({ ok: true }))

  registerClientRoutes(app)
  registerAdminRoutes(app)
  registerDaemonApiRoutes(app)

  return app
}
