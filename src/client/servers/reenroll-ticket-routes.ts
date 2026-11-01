import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { encodeLicenseArg } from '../../features/install/daemon-install-command.ts'
import { requireStepUpIfConfigured } from '../authn/step-up.ts'
import { requireServerOwnerContext } from './owner-context.ts'
import { mintTicket, revokeServerTickets } from '../../features/licenses/tickets.ts'

/**
 * Owner-issued re-enroll ticket (`POST /servers/:id/reenroll-ticket`): one
 * hour, single use, bound to this server. It is how a server whose daemon key
 * was lost gets a new one; the secret is shown once and stored hashed.
 * `DELETE` revokes any that are still unused.
 */
export function registerServerReenrollTicketRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server re-enroll ticket routes')
  }
  router.use('/servers/:id/reenroll-ticket', createSessionMiddleware(opts.secrets))

  router.post('/servers/:id/reenroll-ticket', async (c) => {
    const ctx = await requireServerOwnerContext(c)
    if (ctx instanceof Response) return ctx
    const { db, session, organizationId, serverId } = ctx

    const stepUp = await requireStepUpIfConfigured(
      c,
      organizationId,
      'server.reenroll_ticket.issue'
    )
    if (stepUp) return stepUp

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
