/**
 * The preamble every organization-scoped client route opens with — database,
 * session, then the request's organization — as one call, so each handler
 * keeps only what is specific to it.
 */

import type { Context } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { type Db, getDb } from '../db/connection.ts'
import type { SessionData } from './authn/session-store.ts'
import { assertCanOr403, listVisible } from './authz/index.ts'
import { resolveEntityOrganizationId } from './authz/create-access-grant.ts'
import { assertCanManageOr403, assertCanReadOr403, getOrgId } from './shared.ts'

export type OrgRequest = {
  db: Db
  session: SessionData
  organizationId: string
}

/**
 * `503 Database unavailable` without a database, `401 Unauthorized` without a
 * session, the organization resolver's own refusal when the request names no
 * organization the user belongs to — in that order, exactly as the handlers
 * wrote it inline.
 */
export async function resolveOrgRequest(c: Context<AppEnv>): Promise<OrgRequest | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const organizationId = await getOrgId(c, session.userId)
  if (organizationId instanceof Response) return organizationId

  return { db, session, organizationId }
}

/**
 * {@link resolveOrgRequest}, then the `:id` entity of `kind`: `404` unless it
 * belongs to the request's organization, then the access check — `read` for
 * `kind` read, `manage` for `organization:manage` on it.
 */
export async function resolveEntityRequest(
  c: Context<AppEnv>,
  kind: string,
  access: 'read' | 'manage'
): Promise<(OrgRequest & { id: string }) | Response> {
  const scope = await resolveOrgRequest(c)
  if (scope instanceof Response) return scope

  const id = c.req.param('id') ?? ''
  const entityOrgId = await resolveEntityOrganizationId(scope.db, kind, id)
  if (entityOrgId !== scope.organizationId) {
    return c.json({ error: 'Not found' }, 404)
  }

  const denied =
    access === 'read'
      ? await assertCanReadOr403(c, kind, id)
      : await assertCanOr403(c, 'organization:manage', kind, id)
  if (denied) return denied

  return { ...scope, id }
}

/**
 * The opening of a list route: {@link resolveOrgRequest}, the organization
 * manage check, then the ids of `kind` the user can see.
 */
export async function resolveVisibleList(
  c: Context<AppEnv>,
  kind: Parameters<typeof listVisible>[1]['kind']
): Promise<(OrgRequest & { visibleIds: string[] }) | Response> {
  const scope = await resolveOrgRequest(c)
  if (scope instanceof Response) return scope

  const manageDenied = await assertCanManageOr403(c, 'organization', scope.organizationId)
  if (manageDenied) return manageDenied

  const visibleIds = await listVisible(scope.db, {
    kind,
    userId: scope.session.userId,
    organizationId: scope.organizationId,
  })
  return { ...scope, visibleIds }
}
