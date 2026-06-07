import { createApp } from './app.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { registerVersionRoute } from './daemon-version.ts'
import { registerSystemRoutes } from './system-routes.ts'
import { registerDevSyncRoutes } from './dev-sync.ts'
import { registerTunnelRoutes } from './tunnel-routes.ts'
import { isDeveloperSurfaceEnabled } from './dev-mode.ts'
import {
  hardenInstanceSocket,
  INSTANCE_SOCKET_MODE,
  prepareInstanceSocket,
  resolveInstanceSocket,
} from './server-paths.ts'

const developerSurface = isDeveloperSurfaceEnabled()
const app = createApp({ developerSurface })
registerVersionRoute(app)
if (developerSurface) {
  registerSystemRoutes(app)
  registerDevSyncRoutes(app)
  registerTunnelRoutes(app)
}
registerDaemonWebSocket(app, { developerSurface })
const socketPath = resolveInstanceSocket()

const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => abort.abort())
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
