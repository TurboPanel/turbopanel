import { Hono } from 'hono'
import { resolveInstanceTlsCaPath } from './server-paths.ts'
import { DAEMON_API_PREFIX } from './surfaces.ts'

/**
 * Daemon-facing surface: endpoints agent nodes and the node installer call.
 * Mounted under {@link DAEMON_API_PREFIX} (`/api/daemon/v1`).
 */
export function registerDaemonApiRoutes(app: Hono) {
  const daemon = new Hono()

  // Platform CA PEM — agents add this to their trust store before dialing in.
  daemon.get('/instance/ca', async (c) => {
    try {
      const cert = await Deno.readTextFile(resolveInstanceTlsCaPath())
      return c.body(cert, 200, { 'content-type': 'application/x-pem-file' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  app.route(DAEMON_API_PREFIX, daemon)
  return app
}
