import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { runAfterResponse } from '../../lib/http/after-response.ts'
import { nudgeTunnelRoutes, tunnelSyncDepsFrom } from '../../features/tunnels/nudge.ts'
import { taskDbOpener } from './task-db.ts'

const LOG_SCOPE = 'tunnel-sync'

/**
 * After a change that forwarding tables and connector lists are built from (a
 * site, its names, a server, an address), send them. The work runs after the
 * response, never inside the request: it can reach many servers, and the
 * periodic sweep sends whatever it misses. Does nothing when the organization
 * has no tunnels.
 *
 * Tests set `tunnelNudgeSchedule` on the context to collect the task and await
 * it instead.
 */
export function nudgeTunnelRoutesAfterResponse(c: Context<AppEnv>, organizationId: string): void {
  const deps = tunnelSyncDepsFrom({
    commandQueue: c.get('commandQueue'),
    secretsConfig: c.get('secretsConfig'),
    dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
  })
  const open = taskDbOpener(c)
  if (!deps || !open) return
  const task = async (): Promise<void> => {
    const handles = open()
    try {
      await nudgeTunnelRoutes(handles.db, deps, organizationId)
    } finally {
      await handles.close().catch(() => {})
    }
  }
  const schedule = c.get('tunnelNudgeSchedule')
  if (schedule) schedule(task)
  else runAfterResponse(c, LOG_SCOPE, task)
}
