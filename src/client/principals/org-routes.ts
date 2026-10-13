/**
 * Principals seen from the organization and from a server.
 *
 * - `GET /organizations/:id/principals` — every principal in the organization:
 *   its name, which forms it has (system user, database login), the servers it
 *   is placed on, the projects and logins that use it and its state.
 * - `DELETE /organizations/:id/principals/:principalId` — remove a principal
 *   its project left behind (project delete keeps principals). Refused while a
 *   service, binding, storage entry, secret or database login still uses it;
 *   otherwise the Linux account is retired on every server it reached, the same
 *   way `DELETE /projects/:projectId/principals/:id` does.
 * - `GET /servers/:id/principals` — the principals placed on one server.
 *
 * Same gate as the organization activity and members routes: an organization
 * the session cannot reach is a 404, one without owner/manager rights a 403.
 * The path id alone drives the check, never the active-organization header.
 */
import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { principal, server } from '../../db/schema.ts'
import {
  listOrganizationPrincipals,
  listServerPrincipals,
} from '../../features/principals/org-listing.ts'
import {
  countPrincipalReferences,
  isPrincipalReferenced,
  PRINCIPAL_IN_USE_ERROR,
  SERVER_PRINCIPAL_PROVIDER,
} from '../../features/principals/store.ts'
import { getCommandQueue } from '../../features/commands/queue.ts'
import { isUuid } from '../access/routes-helpers.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import type { SessionData } from '../authn/session-store.ts'
import { canManageOrganization } from '../authz/index.ts'
import { canAccessOrganization } from '../org-context.ts'
import { retireDeletedPrincipal, serversForPrincipal } from './reconcile.ts'

export const PRINCIPAL_HAS_PROJECT_CODE = 'principal_has_project'
export const PRINCIPAL_HAS_PROJECT_ERROR =
  'This principal still belongs to a project; remove it from the project instead'
export const PRINCIPAL_NOT_SYSTEM_USER_CODE = 'principal_not_system_user'
export const PRINCIPAL_NOT_SYSTEM_USER_ERROR =
  'Only a system user can be removed here; database logins are removed with their database'

type OrgScope = { db: Db; session: SessionData; organizationId: string }

/** 404 for an organization the session cannot reach, 403 without manager rights. */
async function resolveOrgScope(
  c: Context<AppEnv>,
  organizationId: string
): Promise<OrgScope | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  if (!isUuid(organizationId)) return c.json({ error: 'Not found' }, 404)
  if (!(await canAccessOrganization(db, session.userId, organizationId))) {
    return c.json({ error: 'Not found' }, 404)
  }
  if (!(await canManageOrganization(db, session.userId, organizationId))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return { db, session, organizationId }
}

export function registerOrganizationPrincipalRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization principal routes')
  }
  const sessions = createSessionMiddleware(opts.secrets)
  router.use('/organizations/:id/principals', sessions)
  router.use('/organizations/:id/principals/:principalId', sessions)
  router.use('/servers/:id/principals', sessions)

  router.get('/organizations/:id/principals', async (c) => {
    const scope = await resolveOrgScope(c, c.req.param('id'))
    if (scope instanceof Response) return scope
    const principals = await listOrganizationPrincipals(scope.db, scope.organizationId)
    return c.json({ principals })
  })

  router.delete('/organizations/:id/principals/:principalId', async (c) => {
    const scope = await resolveOrgScope(c, c.req.param('id'))
    if (scope instanceof Response) return scope
    const { db, session, organizationId } = scope
    const principalId = c.req.param('principalId')
    if (!isUuid(principalId)) return c.json({ error: 'Not found' }, 404)

    const [row] = await db
      .select()
      .from(principal)
      .where(and(eq(principal.id, principalId), eq(principal.organizationId, organizationId)))
      .limit(1)
    if (!row) return c.json({ error: 'Not found' }, 404)

    if (row.projectId !== null) {
      return c.json({ error: PRINCIPAL_HAS_PROJECT_ERROR, code: PRINCIPAL_HAS_PROJECT_CODE }, 409)
    }
    if (row.provider !== SERVER_PRINCIPAL_PROVIDER) {
      return c.json(
        { error: PRINCIPAL_NOT_SYSTEM_USER_ERROR, code: PRINCIPAL_NOT_SYSTEM_USER_CODE },
        409
      )
    }

    const usedBy = await countPrincipalReferences(db, principalId)
    if (isPrincipalReferenced(usedBy)) {
      return c.json({ error: PRINCIPAL_IN_USE_ERROR, usedBy }, 409)
    }

    // Resolved before the delete: the reach is found through the placements.
    const serverIds = await serversForPrincipal(db, principalId)
    await db.delete(principal).where(eq(principal.id, principalId))

    const reconciled = await retireDeletedPrincipal(
      db,
      getCommandQueue(c),
      { actorType: 'user', actorId: session.userId },
      { serverIds, appliedUsername: row.appliedUsername }
    )
    return c.json({ ok: true as const, reconciled })
  })

  router.get('/servers/:id/principals', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const serverId = c.req.param('id')
    if (!isUuid(serverId)) return c.json({ error: 'Not found' }, 404)

    // The server's own organization decides access, so a server of another
    // organization is a 404 whatever header the request carries.
    const [row] = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    if (
      !row?.organizationId ||
      !(await canAccessOrganization(db, session.userId, row.organizationId))
    ) {
      return c.json({ error: 'Not found' }, 404)
    }
    if (!(await canManageOrganization(db, session.userId, row.organizationId))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    return c.json({ serverId, principals: await listServerPrincipals(db, serverId) })
  })
}
