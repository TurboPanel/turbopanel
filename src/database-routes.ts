import { sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import {
  drizzleStudioProbeStatus,
  postgresConfigFromContext,
} from './database-routes-shared.ts'
import { getDb } from './db.ts'

export type DatabaseStatus = {
  configured: boolean
  connected: boolean
  transport: 'socket' | 'tcp' | null
  user: string | null
  database: string | null
  version: string | null
  error: string | null
}

/** Workers-safe database diagnostics (status + studio probe). */
export function registerDatabaseRoutes(developer: Hono): void {
  developer.get('/database/status', async (c) => {
    const meta = postgresConfigFromContext(c)
    if (!meta.configured) {
      const body: DatabaseStatus = {
        ...meta,
        connected: false,
        version: null,
        error: 'postgres is not configured (missing database URL)',
      }
      return c.json(body)
    }

    const db = getDb(c)
    if (!db) {
      const body: DatabaseStatus = {
        ...meta,
        connected: false,
        version: null,
        error: 'database client failed to initialize',
      }
      return c.json(body)
    }

    try {
      const result = await db.execute(
        sql`SELECT version() AS version, current_database() AS database`,
      )
      const row = result.at(0) as { version?: string; database?: string } | undefined
      const body: DatabaseStatus = {
        ...meta,
        database: row?.database ?? meta.database,
        connected: true,
        version: row?.version ?? null,
        error: null,
      }
      return c.json(body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const body: DatabaseStatus = {
        ...meta,
        connected: false,
        version: null,
        error: message,
      }
      return c.json(body)
    }
  })

  developer.get('/database/studio', async () => {
    const status = await drizzleStudioProbeStatus()
    return Response.json({
      running: status.running,
      browserUrl: status.browserUrl,
      port: status.port,
    })
  })
}
