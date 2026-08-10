import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { getDb } from '../../db.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { getOrgId } from '../shared.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { findSystemEnvironmentForServer } from './hierarchy.ts'
import { systemComponentOperations } from './operate.ts'
import {
  isSystemOperateComponent,
  mapSystemRestartFailure,
  systemRestartQueuedResponse,
} from './routes-helpers.ts'

export {
  SYSTEM_OPERATE_COMPONENTS,
  type SystemOperateComponent,
} from './routes-helpers.ts'

export function registerSystemRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  const { secrets } = opts
  router.use('/servers/:id/system/*', createSessionMiddleware(secrets))

  router.post('/servers/:id/system/:component/restart', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serverId = c.req.param('id')
    const component = c.req.param('component')

    if (!isSystemOperateComponent(component)) {
      return c.json({ error: 'unknown_system_component' }, 400)
    }

    if (!(await verifyServerInOrg(db, serverId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(c, 'system:operate', 'server', serverId)
    if (denied) return denied

    const environmentId = await findSystemEnvironmentForServer(
      db,
      serverId,
      component,
    )
    if (!environmentId) {
      return c.json({ error: 'system_component_not_provisioned' }, 404)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const result = await systemComponentOperations.restart({
      serverId,
      environmentId,
      component,
      actorId: session.userId,
      db,
      commandQueue,
    })

    if (!result.ok) {
      const failure = mapSystemRestartFailure(result.reason)
      return c.json({ error: failure.error }, failure.status)
    }

    return c.json(systemRestartQueuedResponse({
      commandId: result.commandId,
      serverId: result.serverId,
    }))
  })
}
