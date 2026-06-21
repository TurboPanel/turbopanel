import type { Hono } from 'hono'
import type { DerivedSecretsConfig } from './auth/secrets.ts'
import type { Db } from './db.ts'
import {
  buildDeveloperRouter,
  mountDeveloperRouter,
} from './developer-routes-core.ts'
import { registerDatabaseStudioRoutes } from './database-studio-routes.ts'

/**
 * Full developer console for Deno (includes Drizzle Studio spawn routes).
 * Workers use {@link registerDeveloperRoutesCore} directly — see workers.ts.
 */
export function registerDeveloperRoutes(
  app: Hono,
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean },
) {
  const developer = buildDeveloperRouter(opts)
  registerDatabaseStudioRoutes(developer)
  mountDeveloperRouter(app, developer)
  return app
}
