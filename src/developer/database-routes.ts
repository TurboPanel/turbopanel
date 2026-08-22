import { sql } from 'drizzle-orm'
import type { Env, Hono } from 'hono'
import {
  drizzleStudioProbeStatus,
  postgresConfigFromContext,
} from './database-routes-shared.ts'
import { getDb } from '../db.ts'
import {
  buildConnectedDatabaseStatus,
  buildDatabaseClientUnavailableStatus,
  buildDatabaseQueryErrorStatus,
  buildDatabaseStudioProbeResponse,
  buildUnconfiguredDatabaseStatus,
} from './database-routes-helpers.ts'

export type { DatabaseStatus } from './database-routes-helpers.ts'

/** Workers-safe database diagnostics (status + studio probe). */
export function registerDatabaseRoutes<E extends Env>(developer: Hono<E>): void {
  developer.get('/database/status', async (c) => {
    const meta = postgresConfigFromContext(c)
    if (!meta.configured) {
      return c.json(buildUnconfiguredDatabaseStatus(
        meta,
        'postgres is not configured (missing database URL)',
      ))
    }

    const db = getDb(c)
    if (!db) {
      return c.json(buildDatabaseClientUnavailableStatus(meta))
    }

    try {
      const result = await db.execute(
        sql`SELECT version() AS version, current_database() AS database`,
      )
      const row = result.at(0) as { version?: string; database?: string } | undefined
      return c.json(buildConnectedDatabaseStatus(meta, row))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json(buildDatabaseQueryErrorStatus(meta, message))
    }
  })

  developer.get('/database/studio', async () => {
    const status = await drizzleStudioProbeStatus()
    return Response.json(buildDatabaseStudioProbeResponse(status))
  })
}
