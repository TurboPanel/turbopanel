import type { Hono } from 'hono'
import { deriveSecretsConfig, parseSecretsEnv } from './auth/secrets.ts'
import { createApp } from './app.ts'
import { createDenoDb } from './db.ts'
import { ensureDbSchemaReady } from './db/schema-push.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { registerVersionRoute } from './daemon-version.ts'
import { registerSystemRoutes } from './system-routes.ts'
import { registerDevSyncRoutes } from './dev-sync.ts'
import { registerTunnelRoutes } from './tunnel-routes.ts'
import { registerDeveloperRoutes } from './developer-routes.ts'
import { isDeveloperSurfaceEnabled } from './dev-mode.ts'
import { stopDrizzleStudio } from './drizzle-studio.ts'
import {
  hardenInstanceSocket,
  prepareInstanceSocket,
  resolveInstanceSocket,
} from './server-paths.ts'
const developerSurface = isDeveloperSurfaceEnabled()
const db = createDenoDb()
if (db) {
  await ensureDbSchemaReady(db)
}
const secretsConfig = parseSecretsEnv(
  Deno.env.get('TURBOPANEL_SECRET'),
  Deno.env.get('TURBOPANEL_SECRETS'),
  'deno',
)
const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
const app = createApp({
  db,
  secrets,
  runtime: 'deno',
  corsOrigins: Deno.env.get('TURBOPANEL_CORS_ORIGINS'),
})
const routes = app as unknown as Hono
if (developerSurface) {
  registerDeveloperRoutes(routes, { secrets, db })
}
registerVersionRoute(routes)
if (developerSurface) {
  registerSystemRoutes(routes, { secrets, db })
  registerDevSyncRoutes(routes, { secrets })
  registerTunnelRoutes(routes, { secrets })
}
registerDaemonWebSocket(routes, { developerSurface, db, secrets })
const socketPath = resolveInstanceSocket()

const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => {
    stopDrizzleStudio()
    abort.abort()
  })
}

await prepareInstanceSocket(socketPath)

Deno.serve({
  path: socketPath,
  signal: abort.signal,
  async onListen({ path }) {
    await hardenInstanceSocket(path)
    console.log(
      `TurboPanel listening on ${path}; developer surface ${
        developerSurface ? 'enabled' : 'disabled'
      }`,
    )
  },
}, app.fetch)
