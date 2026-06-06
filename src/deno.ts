import { createApp } from './app.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { broadcastToDaemons, type DaemonMessage } from './daemon-hub.ts'
import { getDaemonCommit, registerVersionRoute } from './daemon-version.ts'
import {
  hardenInstanceSocket,
  INSTANCE_SOCKET_MODE,
  prepareInstanceSocket,
  resolveInstanceSocket,
} from './server-paths.ts'

const app = createApp()
registerVersionRoute(app)
registerDaemonWebSocket(app)
const socketPath = resolveInstanceSocket()

const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  Deno.addSignalListener(signal, () => abort.abort())
}

// Watch the daemon checkout's commit and push it to all connected agents when it
// changes, so a `git pull` on this host rolls out to the fleet without waiting
// for each agent's fallback poll.
let lastBroadcastCommit: string | undefined
const versionWatch = setInterval(async () => {
  try {
    const version = await getDaemonCommit(true)
    if (
      version.commit === 'unknown' || version.commit === lastBroadcastCommit
    ) return
    lastBroadcastCommit = version.commit
    const message: DaemonMessage = {
      type: 'version',
      commit: version.commit,
      branch: version.branch,
      at: new Date().toISOString(),
    }
    broadcastToDaemons(message)
  } catch (err) {
    console.warn(
      '[version] watch failed:',
      err instanceof Error ? err.message : err,
    )
  }
}, 30_000)
abort.signal.addEventListener('abort', () => clearInterval(versionWatch))

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
