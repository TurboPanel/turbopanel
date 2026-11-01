import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { recordAuditAndNotify } from '../../features/notifications/audit-bridge.ts'
import {
  loadOrganizationTierSpare,
  setServerPreferredTier,
} from '../../features/tiers/server-preferred-tier.ts'
import { withTierPlacementExtras } from '../../features/tiers/tier-enforcement.ts'
import { requireServerOwnerContext } from './owner-context.ts'
import { parseJsonBody } from '../shared.ts'

type ParsedTierIdBody = Readonly<{ ok: true; tierId: string | null }> | Readonly<{ ok: false }>

function parseTierIdBody(body: unknown): ParsedTierIdBody {
  if (body === null || typeof body !== 'object') return { ok: false }
  const tierId = (body as { tierId?: unknown }).tierId
  if (tierId === null) return { ok: true, tierId: null }
  if (typeof tierId !== 'string' || tierId.length === 0) return { ok: false }
  return { ok: true, tierId }
}

export function registerServerLicenseTierRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server license-tier routes')
  }
  router.use('/servers/:id/license-tier', createSessionMiddleware(opts.secrets))

  router.put('/servers/:id/license-tier', async (c) => {
    const ctx = await requireServerOwnerContext(c)
    if (ctx instanceof Response) return ctx
    const { db, session, organizationId, serverId } = ctx

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseTierIdBody(body)
    if (!parsed.ok) {
      return c.json({ error: 'invalid_body', code: 'invalid_body' }, 400)
    }

    const result = await setServerPreferredTier(db, organizationId, serverId, parsed.tierId)
    if (!result.ok) {
      if (result.code === 'tier_below_required') {
        return c.json(
          {
            error: "That tier's CPU or RAM limit is below what this server has",
            code: 'tier_below_required',
          },
          422
        )
      }
      if (result.code === 'no_free_seat') {
        return c.json(
          { error: 'No free license at that tier; buy one first', code: 'no_free_seat' },
          409
        )
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
      tierPickNotice: null,
      tiersFree: result.tiersFree,
    })
  })
}

export async function enrichServerDetailTierPlacement(
  db: import('../../db/connection.ts').Db,
  organizationId: string,
  placement: import('../../features/tiers/tier-enforcement.ts').TierPlacementDto | null
) {
  if (!placement) return null
  const tiersFree = await loadOrganizationTierSpare(db, organizationId)
  return withTierPlacementExtras(placement, {
    pickedTier: placement.pickedTier,
    tierPickNotice: null,
    tiersFree,
  })
}
