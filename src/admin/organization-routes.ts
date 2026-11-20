/**
 * `GET /api/admin/v1/organizations` — every organization with its owner and
 * counts, for platform admins (the admin middleware already required `admin`
 * or `superadmin`). Deleting one goes through the client route
 * `DELETE /organizations/:id`, which holds the same rules for a platform admin
 * as for an owner (see `client/organizations/delete-routes.ts`).
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { findDefaultInstalledOrganizationId } from '../client/authn/install-state.ts'
import { getDb } from '../db/connection.ts'
import { listOrganizationsForAdmin } from '../features/organizations/admin-list.ts'

export function registerOrganizationAdminRoutes(admin: Hono<AppEnv>) {
  admin.get('/organizations', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const rootOrganizationId = await findDefaultInstalledOrganizationId(db)
    const organizations = await listOrganizationsForAdmin(db, rootOrganizationId)
    return c.json({ ok: true as const, organizations })
  })
}
