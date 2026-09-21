/**
 * Read organization-wide managed-database defaults.
 *
 * Kept separate from `context.ts` so the ingress desired-state builder (which
 * has no Hono request context) can load the same inheritance source without
 * importing the route-authorization module.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import {
  type ManagedIngressPorts,
  resolveManagedIngressPorts,
} from './ingress-ports.ts'
import type { ManagedOrganizationDefaults } from './org-defaults.ts'
import {
  parseOrganizationOptions,
  resolveRandomizedPrincipalUsernames,
} from '../organizations/organization-options.ts'

/** Read `organization.options.managedDatabase` (missing org → no defaults). */
export async function loadManagedOrgDefaults(
  db: Db,
  organizationId: string,
): Promise<ManagedOrganizationDefaults> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return parseOrganizationOptions(row?.options).managedDatabase ?? {}
}

/**
 * Effective randomized-usernames default for the organization (on unless the
 * org opted out). Governs whether new principals get a random `_<11>` applied
 * suffix; a missing org row resolves to the platform default (on).
 */
export async function loadRandomizedUsernamesDefault(
  db: Db,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return resolveRandomizedPrincipalUsernames(
    parseOrganizationOptions(row?.options),
  )
}

/**
 * Effective shared-ProxySQL client listener ports for an org.
 *
 * Callers must pass the **server-owner** organization, not the org of the
 * project asking: one ProxySQL frontend binds one pair of ports for every
 * cluster on that host, so the host's owner is the only stable source.
 */
export async function loadManagedIngressPorts(
  db: Db,
  organizationId: string,
): Promise<ManagedIngressPorts> {
  return resolveManagedIngressPorts(
    (await loadManagedOrgDefaults(db, organizationId)).ports,
  )
}
