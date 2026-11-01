import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { encodeLicenseArg } from '../../features/install/daemon-install-command.ts'
import { mintTicket, revokeServerTickets } from '../../features/licenses/tickets.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { getOrgId } from '../shared.ts'

/**
 * Owner-issued re-enroll ticket (`POST /servers/:id/reenroll-ticket`): one
 * hour, single use, bound to this server. It is how a server whose daemon key
 * was lost gets a new one; the secret is shown once and stored hashed.
 * `DELETE` revokes any that are still unused.
 */
type ServerOwnerContext = Readonly<{
  db: Db
  session: { userId: string; email?: string | null }
  organizationId: string
  serverId: string
}>

/** The signed-in owner of the organization the server belongs to, or the refusal to return. */
async function requireServerOwnerContext(
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

export function registerServerReenrollTicketRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server re-enroll ticket routes')
  }
  router.use('/servers/:id/reenroll-ticket', createSessionMiddleware(opts.secrets))

  router.post('/servers/:id/reenroll-ticket', async (c) => {
    const ctx = await requireServerOwnerContext(c)
    if (ctx instanceof Response) return ctx
    const { db, session, organizationId, serverId } = ctx

    // One live ticket per server: issuing a new one retires the old.
    await revokeServerTickets(db, serverId)
    const issued = await mintTicket(db, { organizationId, serverId, userId: session.userId })
    await recordAudit(db, {
      organizationId,
      actorUserId: session.userId,
      actorEmail: session.email,
      action: 'server.reenroll_ticket.issue',
      targetType: 'server',
      targetId: serverId,
      context: { expiresAt: issued.expiresAt },
    })
    return c.json({
      ticketId: issued.id,
      expiresAt: issued.expiresAt,
      licenseToken: issued.plaintext,
      licenseArg: encodeLicenseArg(issued.id, issued.plaintext),
    })
  })

  router.delete('/servers/:id/reenroll-ticket', async (c) => {
    const ctx = await requireServerOwnerContext(c)
    if (ctx instanceof Response) return ctx
    const { db, session, organizationId, serverId } = ctx
    const revoked = await revokeServerTickets(db, serverId)
    await recordAudit(db, {
      organizationId,
      actorUserId: session.userId,
      actorEmail: session.email,
      action: 'server.reenroll_ticket.revoke',
      targetType: 'server',
      targetId: serverId,
      context: { revoked },
    })
    return c.json({ ok: true as const, revoked })
  })
}
