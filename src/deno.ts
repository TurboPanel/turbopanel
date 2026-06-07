import { createApp } from './app.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { registerVersionRoute } from './daemon-version.ts'
import { registerSystemRoutes } from './system-routes.ts'
import { registerDevSyncRoutes } from './dev-sync.ts'
import { registerTunnelRoutes } from './tunnel-routes.ts'
import {
  hardenInstanceSocket,
  INSTANCE_SOCKET_MODE,
  prepareInstanceSocket,
  resolveInstanceSocket,
} from './server-paths.ts'

const app = createApp()
registerVersionRoute(app)
registerSystemRoutes(app)
registerDevSyncRoutes(app)
registerTunnelRoutes(app)
registerDaemonWebSocket(app)
const socketPath = resolveInstanceSocket()

const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => abort.abort())
}

// Note: the daemon never self-updates. There is no version watcher/broadcast.
// Updates are operator-driven (admin "Upgrade System" button / dev-sync) and
// the daemon owns all installs/updates via Ansible.

await prepareInstanceSocket(socketPath)

Deno.serve({
  path: socketPath,
  signal: abort.signal,
  async onListen({ path }) {
    await hardenInstanceSocket(path)
    console.log(
      `TurboPanel listening on ${path} (mode ${
        INSTANCE_SOCKET_MODE.toString(8)
      })`,
    )
  },
}, app.fetch)
