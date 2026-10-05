import { asc, eq, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import { getDb, type Db } from '../../db/connection.ts'
import { environment, project, service, variable } from '../../db/schema.ts'
import {
  isComposeChainError,
  resolveComposeLayerChain,
} from '../../features/compose/layer-chain.ts'
import type { ComposeLayer } from '../../features/compose/layers.ts'
import {
  buildEnvironmentConfigView,
  type ConfigVariableInput,
} from '../../features/compose/config-view.ts'
import { assertCanReadOr403, getOrgId } from '../shared.ts'

/** Only the filename a layer is labelled with; the view never shows it. */
const ENVIRONMENT_LAYER_FILENAME = 'docker-compose.environment.yml'

const COMPOSE_UNREADABLE_BODY = {
  error: 'compose_invalid',
  message:
    'A saved compose file for this project or environment could not be read, so there is nothing to compare. Open the compose editor, fix it and save it first.',
} as const

async function loadVariableScope(
  db: Db,
  scope: { projectId: string } | { environmentId: string }
): Promise<ConfigVariableInput[]> {
  const parent =
    'projectId' in scope
      ? eq(variable.projectId, scope.projectId)
      : eq(variable.environmentId, scope.environmentId)
  return await db
    .select({
      id: variable.id,
      key: variable.key,
      // A secret's stored value is sealed ciphertext: it is never even read.
      value: sql<string>`case when ${variable.isSecret} then '' else ${variable.value} end`,
      isSecret: variable.isSecret,
      forBuild: variable.isForBuild,
      forRuntime: variable.isForRuntime,
    })
    .from(variable)
    .where(parent)
    .orderBy(asc(variable.key))
}

async function loadServiceIds(db: Db, environmentId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: service.id, name: service.composeServiceName })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  return new Map(rows.map((row) => [row.name, row.id]))
}

/**
 * GET /environments/:id/config-view — what this environment really runs (the
 * project's Base compose merged with the environment's own compose, by the same
 * merge a deploy uses), what it does differently from the Base and where each
 * value comes from, and whether it follows the Base or stands alone.
 *
 * Read-only and derived: nothing is stored, no deploy preparation runs (so no
 * container or volume rows are allocated), and variable values flagged secret
 * are never sent.
 */
export function registerEnvironmentConfigViewRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment config-view routes')
  }
  router.use('/environments/:id/config-view', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/config-view', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const environmentId = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
    if (!entityOrgId || entityOrgId !== orgResult) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied

    const [row] = await db
      .select({
        id: environment.id,
        name: environment.name,
        projectId: environment.projectId,
        environmentOptions: environment.options,
        projectOptions: project.options,
      })
      .from(environment)
      .innerJoin(project, eq(project.id, environment.projectId))
      .where(eq(environment.id, environmentId))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const layers = resolveComposeLayerChain({
      projectOptions: row.projectOptions,
      environmentOptions: row.environmentOptions,
      environmentFilename: ENVIRONMENT_LAYER_FILENAME,
    })
    if (isComposeChainError(layers)) return c.json(COMPOSE_UNREADABLE_BODY, 422)

    const view = await buildView(db, row, layers)
    if (!view) return c.json(COMPOSE_UNREADABLE_BODY, 422)

    return c.json({
      ok: true as const,
      environmentId: row.id,
      projectId: row.projectId,
      ...view,
    })
  })
}

async function buildView(
  db: Db,
  row: { id: string; projectId: string },
  layers: readonly ComposeLayer[]
) {
  const [serviceIds, projectVariables, environmentVariables] = await Promise.all([
    loadServiceIds(db, row.id),
    loadVariableScope(db, { projectId: row.projectId }),
    loadVariableScope(db, { environmentId: row.id }),
  ])
  try {
    return buildEnvironmentConfigView({
      layers,
      serviceIds,
      projectVariables,
      environmentVariables,
    })
  } catch {
    return null
  }
}
