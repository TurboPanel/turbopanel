/**
 * The contact address kept for an organization's Let's Encrypt account.
 *
 * It lives in `organization.acme_contact_email` (set through
 * `PUT /organizations/:id/tls-settings`, and required to turn Let's Encrypt
 * on). The server never fills it in from a member's account; the screen only
 * suggests the signed-in person's address, which they can change.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'

/** The organization's certificate contact address, or null when none is set. */
export async function organizationAcmeContactEmail(
  db: Db,
  organizationId: string
): Promise<string | null> {
  const [row] = await db
    .select({ acmeContactEmail: organization.acmeContactEmail })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row?.acmeContactEmail ?? null
}
