import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { recordAuditAndNotify } from '../../features/notifications/audit-bridge.ts'
import { setServerPreferredTier } from '../../features/tiers/server-preferred-tier.ts'
import {
  loadOrganizationTierSpare,
  tierPickNoticeForServer,
} from '../../features/tiers/server-preferred-tier.ts'
import { withTierPlacementExtras } from '../../features/tiers/tier-enforcement.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { getDb } from '../../db/connection.ts'
import { getOrgId, parseJsonBody } from '../shared.ts'

function parseTierIdBody(body: unknown): string | null | 'invalid' {
  if (body === null || typeof body !== 'object') return 'invalid'
  const tierId = (body as { tierId?: unknown }).tierId
  if (tierId === null) return null
  if (typeof tierId !== 'string' || tierId.length === 0) return 'invalid'
  return tierId
}

export function registerServerLicenseTierRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server license-tier routes')
  }
  router.use('/servers/:id/license-tier', createSessionMiddleware(opts.secrets))

  router.put('/servers/:id/license-tier', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const serverId = c.req.param('id')
    const denied = await assertOrgOwnerOr403(c, 'organization', organizationId)
    if (denied) return denied

    if (!(await verifyServerInOrg(db, serverId, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const tierId = parseTierIdBody(body)
    if (tierId === 'invalid') {
      return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400)
    }

    const result = await setServerPreferredTier(db, organizationId, serverId, tierId)
    if (!result.ok) {
      if (result.code === 'tier_below_required') {
        return c.json({ error: 'Tier is below what this server needs', code: 'tier_below_required' }, 422)
      }
      if (result.code === 'tier_not_found') {
        return c.json({ error: 'Not found', code: 'tier_not_found' }, 404)
      }
      return c.json({ error: 'Not found', code: 'server_not_licensed' }, 404)
    }

    await recordAuditAndNotify(c, {
      organizationId,
      actorUserId: session.userId,
      actorEmail: session.email,
      action: 'server.license_tier.set',
      targetType: 'server',
      targetId: serverId,
      context: {
        preferredTierId: result.preferredTierId,
        preferredTierLabel: result.preferredTierLabel,
        assignedTierLabel: result.assignedTierLabel,
      },
    })

    return c.json({
      ok: true as const,
      assignedTier: result.assignedTierLabel,
      assignedTierId: result.assignedTierId,
      pickedTier: result.preferredTierLabel,
      pickedTierId: result.preferredTierId,
      tierPickNotice: result.tierPickNotice,
      tiersFree: result.tiersFree,
    })
  })
}

export async function enrichServerDetailTierPlacement(
  db: import('../../db/connection.ts').Db,
  organizationId: string,
  serverId: string,
  placement: import('../../features/tiers/tier-enforcement.ts').TierPlacementDto | null
) {
  if (!placement) return null
  const [tierPickNotice, tiersFree] = await Promise.all([
    tierPickNoticeForServer(db, organizationId, serverId),
    loadOrganizationTierSpare(db, organizationId),
  ])
  return withTierPlacementExtras(placement, {
    pickedTier: placement.pickedTier,
    tierPickNotice,
    tiersFree,
  })
}
