/**
 * The contact address on an organization's Let's Encrypt orders.
 *
 * It lives in `organization.options.acmeContactEmail` (set through
 * `PUT /organizations/:id/tls-settings`). There is no fallback to a member's
 * account address: an organization can have several owners, and one person's
 * address is not handed to the authority unasked. Unset means no shared order
 * starts, and the panel asks the organization to add one.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import { parseOrganizationOptions, resolveAcmeContactEmail } from './organization-options.ts'

/** The organization's certificate contact address, or null when none is set. */
export async function organizationAcmeContactEmail(
  db: Db,
  organizationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row ? resolveAcmeContactEmail(parseOrganizationOptions(row.options)) : null
}
