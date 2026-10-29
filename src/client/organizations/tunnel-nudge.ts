import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { createWorkersDb, endDbConnection, getDb, type Db } from '../../db/connection.ts'
import { runAfterResponse } from '../../lib/http/after-response.ts'
import { nudgeTunnelRoutes, tunnelSyncDepsFrom } from '../../features/tunnels/nudge.ts'

const LOG_SCOPE = 'tunnel-sync'

type TaskDb = { db: Db; close: () => Promise<void> }

/**
 * The deferred task's own database client. Workers: a fresh one from the
 * connection string, closed when the task ends (`src/workers.ts` closes the
 * request's client in its own `waitUntil`, and a task that kept using it would
 * race that close). Deno: the process client, which nothing closes.
 */
function taskDbOpener(c: Context<AppEnv>): (() => TaskDb) | null {
  if (c.get('runtime') === 'workers') {
    const connectionString = c.get('postgresConnectionString')
    if (!connectionString) return null
    return () => {
      const db = createWorkersDb({ connectionString })
      return { db, close: () => endDbConnection(db) }
    }
  }
  const db = getDb(c)
  return db ? () => ({ db, close: () => Promise.resolve() }) : null
}

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
