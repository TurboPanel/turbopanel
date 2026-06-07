import { Hono } from 'hono'
import { createApp } from './app.ts'
import { createDenoDb } from './db.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { registerVersionRoute } from './daemon-version.ts'
import { registerSystemRoutes } from './system-routes.ts'
import { registerDevSyncRoutes } from './dev-sync.ts'
import { registerTunnelRoutes } from './tunnel-routes.ts'
import { isDeveloperSurfaceEnabled } from './dev-mode.ts'
import { stopDrizzleStudio } from './drizzle-studio.ts'
import {
  hardenInstanceSocket,
  INSTANCE_SOCKET_MODE,
  prepareInstanceSocket,
  resolveInstanceSocket,
} from './server-paths.ts'

const developerSurface = isDeveloperSurfaceEnabled()
const db = createDenoDb()
const app = createApp({ developerSurface, db })
const routes = app as unknown as Hono
registerVersionRoute(routes)
if (developerSurface) {
  registerSystemRoutes(routes)
  registerDevSyncRoutes(routes)
  registerTunnelRoutes(routes)
}
registerDaemonWebSocket(routes, { developerSurface, db })
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
