import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { getDaemonCellRegistry, getDb, getExecutionLogStore } from '../../db/connection.ts'
import { assertCanReadOr403 } from '../shared.ts'
import { authorizeEnvironmentManage } from './deploy-routes.ts'
import { cancelEnvironmentDeploy } from '../../features/deploy/deploy-cancel.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import {
  DEPLOYMENT_HISTORY_DEFAULT_LIMIT,
  DEPLOYMENT_HISTORY_MAX_LIMIT,
  getEnvironmentDeploymentDetail,
  listEnvironmentDeploymentHistory,
} from '../../features/deploy/deployment-history.ts'

export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEPLOYMENT_HISTORY_DEFAULT_LIMIT
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > DEPLOYMENT_HISTORY_MAX_LIMIT) {
    return null
  }
  return parsed
}

/**
 * Environment deploy **history**, read from the append-only `command` table —
 * `deployment` is upsert-per-(environment, server) current state and cannot
 * answer "list past deploys". `:deploymentId` is therefore a `command.id`, and
 * the same id fetches the transcript via the existing command-log route.
 */
export function registerEnvironmentDeploymentHistoryRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment deployment-history routes')
  }
  router.use('/environments/:id/deployments', createSessionMiddleware(opts.secrets))
  router.use('/environments/:id/deployments/*', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/deployments', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied

    const limit = parseLimit(c.req.query('limit'))
    if (limit === null) {
      return c.json(
        { error: `limit must be an integer between 1 and ${DEPLOYMENT_HISTORY_MAX_LIMIT}` },
        400
      )
    }

    const before = c.req.query('before')
    const page = await listEnvironmentDeploymentHistory(db, environmentId, {
      limit,
      ...(before ? { before } : {}),
      logStore: getExecutionLogStore(c),
    })

    return c.json({ ok: true as const, ...page })
  })

  router.get('/environments/:id/deployments/:deploymentId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied

    const detail = await getEnvironmentDeploymentDetail(
      db,
      environmentId,
      c.req.param('deploymentId'),
      { logStore: getExecutionLogStore(c) }
    )
    if (!detail) return c.json({ error: 'Not found' }, 404)

    return c.json({ ok: true as const, deployment: detail })
  })

  /**
   * Cancel a deploy that is queued or running. `:deploymentId` is a command id;
   * the whole deploy (every server of that generation, and any rollout batch
   * still waiting) is cancelled. Manage-gated like deploy and stop. No step-up:
   * a re-deploy fully reverses a cancel (see `step-up-actions.ts`).
   */
  router.post('/environments/:id/deployments/:deploymentId/cancel', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeEnvironmentManage(c, db, environmentId)
    if (auth instanceof Response) return auth

    const deploymentId = c.req.param('deploymentId')
    const result = await cancelEnvironmentDeploy(db, getDaemonCellRegistry(c), {
      environmentId,
      deploymentId,
    })
    if (!result.ok) return c.json({ error: result.error }, result.status)

    // An already-cancelled deploy changed nothing, so it adds no audit row.
    if (result.state !== 'already_cancelled') {
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        actorEmail: c.get('session')?.email ?? null,
        action: 'deployment.cancel',
        targetType: 'environment',
        targetId: environmentId,
        context: { deploymentId, state: result.state, serverIds: result.serverIds },
      })
    }
    return c.json({
      ok: true as const,
      state: result.state,
      environmentId,
      deploymentId,
    })
  })
}
