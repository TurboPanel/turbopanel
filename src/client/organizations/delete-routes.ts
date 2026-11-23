/**
 * `DELETE /organizations/:id?confirmName=<exact name>` — delete an organization
 * and everything it owns (`deleteOrganization`).
 *
 * Who: the organization's owner, or a platform admin (`organization:own`, which
 * platform admins hold everywhere). A manager who is not the owner is refused.
 *
 * Order of refusals: 401, 404 (unknown, or an organization the caller cannot see, as on
 * `GET /organizations/:id`), 403, 403 `reauth_required` (always on, whatever
 * the organization's switch says), 400 `confirm_name_required`, then 409 for
 * `root_organization`, `organization_has_servers`, `organization_has_tunnels`
 * and `organization_has_dns_records`. A server is never moved, shared or
 * disconnected on the way: servers are purged or removed first, one by one.
 * Tunnels and DNS records exist at a provider that this delete cannot reach
 * back to, so they are removed first too.
 *
 * The blockers are counted again under a row lock inside the delete transaction, so a
 * server added meanwhile still answers 409. The audit row is written in that same
 * transaction, with no organization id (the organization's own audit rows go with it)
 * so the platform trail keeps it.
 */
import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import {
  deleteOrganizationIfClear,
  type OrganizationDeleteBlockers,
} from '../../features/organizations/delete-organization.ts'
import { canAccessOrganization } from '../org-context.ts'
import { findDefaultInstalledOrganizationId } from '../authn/install-state.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { requireInstanceStepUp } from '../authn/step-up.ts'
import { assertOrgOwnerOr403 } from '../authz/index.ts'
import { confirmationName, refuseUnlessNameConfirmed } from '../confirm-name.ts'

export const ORGANIZATION_ROOT_ERROR = 'root_organization'
export const ORGANIZATION_HAS_SERVERS_ERROR = 'organization_has_servers'
export const ORGANIZATION_HAS_TUNNELS_ERROR = 'organization_has_tunnels'
export const ORGANIZATION_HAS_DNS_RECORDS_ERROR = 'organization_has_dns_records'

/** The 409 for the first blocker, in the order servers, tunnels, DNS records. */
function blockedResponse(c: Context<AppEnv>, blockers: OrganizationDeleteBlockers) {
  if (blockers.servers > 0) {
    return c.json(
      {
        error: ORGANIZATION_HAS_SERVERS_ERROR,
        code: ORGANIZATION_HAS_SERVERS_ERROR,
        message:
          'This organization still has servers. Purge or remove every server first; servers are never moved to another organization.',
        serverCount: blockers.servers,
      },
      409
    )
  }
  if (blockers.tunnels > 0) {
    return c.json(
      {
        error: ORGANIZATION_HAS_TUNNELS_ERROR,
        code: ORGANIZATION_HAS_TUNNELS_ERROR,
        message: 'This organization still has tunnels. Remove every tunnel first.',
        tunnelCount: blockers.tunnels,
      },
      409
    )
  }
  return c.json(
    {
      error: ORGANIZATION_HAS_DNS_RECORDS_ERROR,
      code: ORGANIZATION_HAS_DNS_RECORDS_ERROR,
      message: 'This organization still has DNS records. Remove them first.',
      dnsRecordCount: blockers.dnsRecords,
    },
    409
  )
}

export function registerOrganizationDeleteRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization routes')
  }
  // The session middleware for `/organizations/:id` is mounted by registerOrganizationRoutes.
  router.delete('/organizations/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const id = c.req.param('id')

    const [row] = await db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!row || !(await canAccessOrganization(db, session.userId, id))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertOrgOwnerOr403(c, 'organization', id)
    if (denied) return denied

    const stepUp = await requireInstanceStepUp(c, 'organization.delete')
    if (stepUp) return stepUp

    const needsName = refuseUnlessNameConfirmed(
      c,
      'organization',
      confirmationName(row.name, row.id)
    )
    if (needsName) return needsName

    if ((await findDefaultInstalledOrganizationId(db)) === id) {
      return c.json(
        {
          error: ORGANIZATION_ROOT_ERROR,
          code: ORGANIZATION_ROOT_ERROR,
          message: 'The root organization belongs to the platform and cannot be deleted.',
        },
        409
      )
    }

    const result = await deleteOrganizationIfClear(db, id, {
      organizationId: null,
      actorUserId: session.userId,
      actorEmail: session.email,
      action: 'organization.delete',
      targetType: 'organization',
      targetId: id,
      context: { name: row.name, actorRole: session.role },
    })
    if (result.status === 'not_found') return c.json({ error: 'Not found' }, 404)
    if (result.status === 'blocked') return blockedResponse(c, result.blockers)
    return c.json({ ok: true as const, id })
  })
}
