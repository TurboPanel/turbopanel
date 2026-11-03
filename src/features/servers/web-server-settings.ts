/**
 * The web server switches a deploy to a server carries.
 *
 * For each switch the server's own setting wins, then its owner's organization
 * default, then the built-in default: names and versions hidden
 * (`resolveEffectiveHideWebServerNames`), the Via header removed
 * (`resolveEffectiveSendViaHeader`). The deploy carries the answer, so a
 * change takes effect on an environment's next deploy.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import { HOSTING_VIA_HEADER_FEATURE } from '../../lib/version-wire.ts'
import { parseOrganizationOptions } from '../organizations/organization-options.ts'
import {
  resolveEffectiveHideWebServerNames,
  resolveEffectiveSendViaHeader,
} from './host-defaults.ts'
import { parseServerOptions } from './server-metadata.ts'

export type WebServerSettings = {
  hideWebServerNames: boolean
  sendViaHeader: boolean
}

/**
 * `organizationId` must be the **server's owner**, the organization whose
 * defaults the host follows.
 */
export async function loadWebServerSettings(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<WebServerSettings> {
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
  const serverOptions = parseServerOptions(serverRow?.options)
  const organizationOptions = parseOrganizationOptions(organizationRow?.options)
  return {
    hideWebServerNames: resolveEffectiveHideWebServerNames(serverOptions, organizationOptions)
      .hideWebServerNames,
    sendViaHeader: resolveEffectiveSendViaHeader(serverOptions, organizationOptions).sendViaHeader,
  }
}

/**
 * The deploy fields for these settings. `sendViaHeader` goes only to a daemon
 * that lists `hosting-via-header-v1`; any other daemon gets no field and keeps
 * tying the Via header to `hideWebServerNames`, as it always has.
 */
export function webServerDeployFields(
  settings: WebServerSettings,
  daemonFeatures: readonly string[] | null | undefined
): { hideWebServerNames: boolean; sendViaHeader?: boolean } {
  return {
    hideWebServerNames: settings.hideWebServerNames,
    ...(daemonFeatures?.includes(HOSTING_VIA_HEADER_FEATURE)
      ? { sendViaHeader: settings.sendViaHeader }
      : {}),
  }
}
