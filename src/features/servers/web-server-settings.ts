/**
 * Whether a deploy to a server hides web server names and versions.
 *
 * The server's own setting wins, then its owner's organization default, and
 * on when neither is set (`resolveEffectiveHideWebServerNames`). The deploy
 * carries the answer, so a change takes effect on an environment's next deploy.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import { parseOrganizationOptions } from '../organizations/organization-options.ts'
import { resolveEffectiveHideWebServerNames } from './host-defaults.ts'
import { parseServerOptions } from './server-metadata.ts'

/**
 * `organizationId` must be the **server's owner**, the organization whose
 * defaults the host follows.
 */
export async function loadHideWebServerNames(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<boolean> {
  const [serverRow] = await db
    .select({ options: server.options })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const [organizationRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return resolveEffectiveHideWebServerNames(
    parseServerOptions(serverRow?.options),
    parseOrganizationOptions(organizationRow?.options)
  ).hideWebServerNames
}
