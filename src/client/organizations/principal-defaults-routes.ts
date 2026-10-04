/**
 * Org principal name defaults: `GET/PUT /organizations/:id/principal-defaults`
 * (scheme + lock, manager-gated). Registered ahead of the generic organization
 * routes in `client/routes.ts`; the older boolean-only handlers in
 * `organizations/routes.ts` are shadowed by these and can be deleted there.
 */
import { eq, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { parseOrganizationOptions } from '../../features/organizations/organization-options.ts'
import {
  parsePrincipalDefaultsPatch,
  principalDefaultsOptionChanges,
  principalDefaultsResponse,
} from '../../features/organizations/principal-defaults.ts'

export function registerOrganizationPrincipalDefaultsRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization routes')
  }
  router.use('/organizations/:id/principal-defaults', createSessionMiddleware(opts.secrets))

  router.get('/organizations/:id/principal-defaults', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    return c.json(principalDefaultsResponse(parseOrganizationOptions(orgRow.options)))
  })

  router.put('/organizations/:id/principal-defaults', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    // Only affects principals created after the change; nothing is renamed.
    const parsed = parsePrincipalDefaultsPatch(body)
    if (!parsed.ok) return c.json({ error: 'Invalid request' }, 400)

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    // One atomic jsonb expression so a concurrent change to another org
    // option is never clobbered by this write.
    const { remove, set } = principalDefaultsOptionChanges(parsed.patch)
    let nextOptions = sql`COALESCE(${organization.options}, '{}'::jsonb)`
    for (const key of remove) nextOptions = sql`${nextOptions} - ${key}::text`
    if (Object.keys(set).length > 0) {
      nextOptions = sql`${nextOptions} || ${JSON.stringify(set)}::jsonb`
    }
    const [updated] = await db
      .update(organization)
      .set({
        options: nextOptions,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(organization.id, id))
      .returning({
        options: organization.options,
      })

    return c.json({
      ok: true as const,
      ...principalDefaultsResponse(parseOrganizationOptions(updated?.options)),
    })
  })
}
