import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { can } from '../authz/index.ts'

/** What an update permission is checked on: one server, or a whole organization. */
export type OrgServersUpdateScope = Readonly<{ kind: 'server' | 'organization'; id: string }>

/**
 * Whether `userId` may start daemon updates for an organization's servers.
 *
 * Today that is the organization's owners and managers plus instance admins
 * (admin and superadmin): `organization:manage`, which `can()` checks against
 * the server's own organization, so a manager of one organization never
 * reaches another organization's servers. This is the one place the rule
 * lives; a dedicated privilege can replace "organization manager" here later.
 */
export function canUpdateOrgServers(
  db: Db,
  userId: string,
  scope: OrgServersUpdateScope
): Promise<boolean> {
  return can(db, userId, 'organization:manage', scope.kind, scope.id)
}

/** {@link canUpdateOrgServers} for a route: null when allowed, else the 401/403/503 to return. */
export async function assertCanUpdateOrgServersOr403(
  c: Context<AppEnv>,
  scope: OrgServersUpdateScope
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  if (!(await canUpdateOrgServers(db, session.userId, scope))) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  return null
}
