import { Hono } from 'hono'
import { registerDaemonRoutes } from './daemon-routes.ts'

export function createApp() {
  const app = new Hono()

  app.get('/', (c) => c.text('TurboPanel'))
  app.get('/api/health', (c) => c.json({ ok: true }))
  registerDaemonRoutes(app)

  return app
}
