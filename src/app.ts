import { Hono } from 'hono'

export function createApp() {
  const app = new Hono()

  app.get('/', (c) => c.text('TurboPanel'))
  app.get('/api/health', (c) => c.json({ ok: true }))

  return app
}
