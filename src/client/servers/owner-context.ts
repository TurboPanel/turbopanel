import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { getOrgId } from '../shared.ts'

export type ServerOwnerContext = Readonly<{
  db: Db
  session: { userId: string; email?: string | null }
  organizationId: string
  serverId: string
}>

/** The signed-in owner of the organization the server belongs to, or the refusal to return. */
export async function requireServerOwnerContext(
  c: Context<AppEnv>
): Promise<ServerOwnerContext | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult
  const serverId = c.req.param('id') ?? ''
  const denied = await assertOrgOwnerOr403(c, 'organization', orgResult)
  if (denied) return denied
  if (!(await verifyServerInOrg(db, serverId, orgResult))) {
    return c.json({ error: 'Not found' }, 404)
  }
  return { db, session, organizationId: orgResult, serverId }
}
