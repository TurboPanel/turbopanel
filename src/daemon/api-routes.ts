import { Hono } from 'hono'
import { isInstanceInstalled } from '../client/authn/install-state.ts'
import { getDb } from '../db.ts'
import { getDaemonOpenApiSpec } from '../openapi.ts'
import { buildDaemonScalarHtml } from '../scalar-html.ts'
import { resolveInstanceTlsCaPath } from '../server-paths.ts'
import { DAEMON_API_PREFIX } from '../surfaces.ts'

/**
 * Daemon-facing surface: endpoints remote daemons and the node installer call.
 * Mounted under {@link DAEMON_API_PREFIX} (`/api/daemon/v1`).
 */
export function registerDaemonApiRoutes(app: Hono) {
  const daemon = new Hono()

  // Co-located self-hosted daemons poll this before opening the daemon WS.
  // Returns 503 until the install wizard has created org + superadmin.
  daemon.get('/readiness', async (c) => {
    const db = getDb(c)
    if (db === undefined) {
      return c.json({ ok: false, error: 'Database unavailable' }, 503)
    }

    const installed = await isInstanceInstalled(db)
    if (!installed) {
      return c.json({ ok: true, ready: false, needsInstall: true }, 503)
    }

    return c.json({ ok: true, ready: true })
  })

  // Platform CA PEM — daemons add this to their trust store before dialing in.
  daemon.get('/instance/ca', async (c) => {
    try {
      const cert = await Deno.readTextFile(resolveInstanceTlsCaPath())
      return c.body(cert, 200, { 'content-type': 'application/x-pem-file' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  daemon.get('/openapi.json', (c) => {
    const origin = new URL(c.req.url).origin
    return c.json(getDaemonOpenApiSpec(origin))
  })

  daemon.get('/reference', (c) => {
    return c.html(buildDaemonScalarHtml('/api/daemon/v1/openapi.json'))
  })

  app.route(DAEMON_API_PREFIX, daemon)
  return app
}
