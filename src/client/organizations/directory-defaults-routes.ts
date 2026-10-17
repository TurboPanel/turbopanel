/**
 * Org folder naming: `GET/PUT /organizations/:id/directory-defaults`
 * (`slug`, `uuid` or `both` for service and volume folders, plus the lock;
 * manager-gated). Registered ahead of the generic organization routes in
 * `client/routes.ts`, next to the principal defaults.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import {
  decideDirectoryDefaultsPatch,
  directoryDefaultsOptionChanges,
  directoryDefaultsResponse,
  parseDirectoryDefaultsPatch,
} from '../../features/organizations/directory-defaults.ts'
import { parseOrganizationOptions } from '../../features/organizations/organization-options.ts'
import {
  DIRECTORY_NAMES_LOCKED_ERROR,
  organizationHasFolders,
} from '../../features/folders/records.ts'

/** True when no folder row exists for any site owner of the organization (re-checked inside the write). */
const NO_FOLDER_ROWS = (organizationId: string) => sql`NOT EXISTS (
  SELECT 1 FROM folder JOIN principal ON principal.id = folder.principal_id
  WHERE principal.organization_id = ${organizationId}::uuid
)`

export function registerOrganizationDirectoryDefaultsRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for organization routes')
  }
  router.use('/organizations/:id/directory-defaults', createSessionMiddleware(opts.secrets))

  router.get('/organizations/:id/directory-defaults', async (c) => {
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

    return c.json(
      directoryDefaultsResponse(
        parseOrganizationOptions(orgRow.options),
        await organizationHasFolders(db, id)
      )
    )
  })

  router.put('/organizations/:id/directory-defaults', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseDirectoryDefaultsPatch(body)
    if (!parsed.ok) return c.json({ error: 'Invalid request' }, 400)

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const foldersExist = await organizationHasFolders(db, id)
    const decision = decideDirectoryDefaultsPatch(
      parsed.patch,
      parseOrganizationOptions(orgRow.options),
      foldersExist
    )
    if (!decision.ok) return c.json({ error: DIRECTORY_NAMES_LOCKED_ERROR }, 409)
    // With a folder in place the only patch that passes writes the value already
    // in force, so there is nothing to store.
    if (foldersExist) {
      return c.json({
        ok: true as const,
        ...directoryDefaultsResponse(parseOrganizationOptions(orgRow.options), true),
      })
    }

    // One atomic jsonb expression so a concurrent change to another org
    // option is never clobbered. The NOT EXISTS guard is best effort against a
    // folder appearing meanwhile (no lock is held on the organization row).
    const { remove, set } = directoryDefaultsOptionChanges(parsed.patch)
    let nextOptions = sql`COALESCE(${organization.options}, '{}'::jsonb)`
    for (const key of remove) nextOptions = sql`${nextOptions} - ${key}::text`
    if (Object.keys(set).length > 0) {
      nextOptions = sql`${nextOptions} || ${JSON.stringify(set)}::jsonb`
    }
    const [updated] = await db
      .update(organization)
      .set({ options: nextOptions, updatedAt: new Date().toISOString() })
      .where(and(eq(organization.id, id), NO_FOLDER_ROWS(id)))
      .returning({ options: organization.options })
    if (!updated) return c.json({ error: DIRECTORY_NAMES_LOCKED_ERROR }, 409)

    return c.json({
      ok: true as const,
      ...directoryDefaultsResponse(parseOrganizationOptions(updated.options), false),
    })
  })
}
