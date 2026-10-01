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
import { type ManagedIngressPorts, resolveManagedIngressPorts } from './ingress-ports.ts'
import type { PrincipalNamePolicy } from '../../lib/principal-name-scheme.ts'
import type { ManagedOrganizationDefaults } from './org-defaults.ts'
import {
  parseOrganizationOptions,
  resolvePrincipalNamePolicy,
} from '../organizations/organization-options.ts'

/** Read `organization.options.managedDatabase` (missing org → no defaults). */
export async function loadManagedOrgDefaults(
  db: Db,
  organizationId: string
): Promise<ManagedOrganizationDefaults> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return parseOrganizationOptions(row?.options).managedDatabase ?? {}
}

/**
 * Effective principal name policy (default scheme + lock) for the
 * organization. Reads the new `principalNameScheme` key, falling back to the
 * legacy `randomizedPrincipalUsernames` boolean (true = partial, false =
 * plain); a missing org row resolves to the platform default (`partial`,
 * unlocked).
 */
export async function loadPrincipalNamePolicy(
  db: Db,
  organizationId: string
): Promise<PrincipalNamePolicy> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return resolvePrincipalNamePolicy(parseOrganizationOptions(row?.options))
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
  organizationId: string
): Promise<ManagedIngressPorts> {
  return resolveManagedIngressPorts((await loadManagedOrgDefaults(db, organizationId)).ports)
}
