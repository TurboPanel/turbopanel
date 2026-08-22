import type { Env, Hono } from 'hono'
import { postgresConfigFromContext } from './database-routes-shared.ts'
import { startDrizzleStudio } from './drizzle-studio.ts'

type StartDrizzleStudio = typeof startDrizzleStudio

/** Deno-only: spawn drizzle-kit studio (not bundled in Workers). */
export function registerDatabaseStudioRoutes<E extends Env>(
  developer: Hono<E>,
  opts?: { startStudio?: StartDrizzleStudio },
): void {
  const startStudio = opts?.startStudio ?? startDrizzleStudio
  developer.post('/database/studio', async (c) => {
    const meta = postgresConfigFromContext(c)
    if (!meta.configured) {
      return c.json(
        { ok: false, error: 'postgres is not configured (missing database URL)' },
        503,
      )
    }

    const started = await startStudio()
    if (!started.ok) {
      const status = started.error.includes('loopback') ? 400 : 500
      return c.json({ ok: false, error: started.error }, status)
    }
    return c.json({
      ok: true,
      browserUrl: started.browserUrl,
      port: started.port,
    })
  })
}
