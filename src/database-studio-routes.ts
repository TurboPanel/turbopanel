import type { Hono } from 'hono'
import { postgresConfigFromContext } from './database-routes-shared.ts'
import { startDrizzleStudio } from './drizzle-studio.ts'

/** Deno-only: spawn drizzle-kit studio (not bundled in Workers). */
export function registerDatabaseStudioRoutes(developer: Hono): void {
  developer.post('/database/studio', async (c) => {
    const meta = postgresConfigFromContext(c)
    if (!meta.configured) {
      return c.json(
        { ok: false, error: 'postgres is not configured (missing database URL)' },
        503,
      )
    }

    const started = await startDrizzleStudio()
    if (!started.ok) {
      return c.json({ ok: false, error: started.error }, 500)
    }
    return c.json({
      ok: true,
      browserUrl: started.browserUrl,
      port: started.port,
    })
  })
}
