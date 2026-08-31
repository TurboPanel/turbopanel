import type { Env, Hono } from 'hono'
import type { DerivedSecretsConfig } from '../client/authn/secrets.ts'
import type { Db } from '../db.ts'
import {
  buildDeveloperRouter,
  mountDeveloperRouter,
} from './routes-core.ts'
import { registerDatabaseStudioRoutes } from './database-studio-routes.ts'
import { registerMetricsDuckDbUiRoutes } from './metrics-duckdb-ui-routes.ts'

/**
 * Full developer console for Deno (includes Drizzle Studio spawn routes and
 * the embedded DuckDB UI action). Workers use
 * {@link registerDeveloperRoutesCore} directly — see workers.ts.
 */
export function registerDeveloperRoutes<E extends Env>(
  app: Hono<E>,
  opts: { secrets: DerivedSecretsConfig; db?: Db; authRequired?: boolean },
) {
  const developer = buildDeveloperRouter(opts)
  registerDatabaseStudioRoutes(developer)
  registerMetricsDuckDbUiRoutes(developer)
  mountDeveloperRouter(app, developer)
  return app
}
