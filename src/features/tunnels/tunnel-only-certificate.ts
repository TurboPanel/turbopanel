/**
 * A hosting whose every name is a locked tunnel name never needs a public
 * certificate: the edge ends TLS and the server answers on its internal one.
 * So it must not hold a Let's Encrypt library row either. This settles that:
 * it drops the hosting's pin to a Let's Encrypt row TurboPanel made for sites,
 * forgets a waiting request, and removes the row once nothing else pins it, so
 * nothing keeps waiting on, or retrying at, the authority.
 *
 * Lock order is the one every pin change uses: the environment row, then the
 * organization's Let's Encrypt lock, then the site and certificate rows.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, hosting, service, tls } from '../../db/schema.ts'
import { pendingLetsEncryptPatch, readPendingLetsEncrypt } from '../hostings/hosting-certificate.ts'
import { parseHostingOptions, readHostingWwwMode } from '../hostings/hosting-options.ts'
import {
  isSiteLetsEncrypt,
  lockOrganizationLetsEncrypt,
  removeUnusedSiteCertificates,
} from '../tls/unused-letsencrypt.ts'
import { isTunnelOnlyHosting } from './name-lock.ts'

const REMOVED_REASON = 'The site only serves tunnel names, which need no public certificate'

/** Drop the site's own Let's Encrypt pin and waiting request. True when something changed. */
async function releaseSitePin(db: Db, hostingId: string, organizationId: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx
      .select({ id: environment.id })
      .from(environment)
      .innerJoin(service, eq(service.environmentId, environment.id))
      .innerJoin(hosting, eq(hosting.serviceId, service.id))
      .where(eq(hosting.id, hostingId))
      .for('update', { of: environment })
    await lockOrganizationLetsEncrypt(tx, organizationId)
    const [row] = await tx
      .select({ tlsId: hosting.tlsId, metadata: hosting.metadata, pendingAt: hosting.pendingAt })
      .from(hosting)
      .where(eq(hosting.id, hostingId))
      .for('update')
    if (!row) return false
    const waiting = readPendingLetsEncrypt({ metadata: row.metadata, pendingAt: row.pendingAt })
    let pinnedId: string | null = null
    if (row.tlsId !== null) {
      const [pinned] = await tx
        .select({ source: tls.source, status: tls.status, metadata: tls.metadata })
        .from(tls)
        .where(eq(tls.id, row.tlsId))
      if (pinned && isSiteLetsEncrypt(pinned)) pinnedId = row.tlsId
    }
    if (waiting === null && pinnedId === null) return false
    await tx
      .update(hosting)
      .set({
        ...(waiting === null ? {} : pendingLetsEncryptPatch(row.metadata, null)),
        ...(pinnedId === null ? {} : { tlsId: null }),
      })
      .where(eq(hosting.id, hostingId))
    if (pinnedId !== null) {
      await removeUnusedSiteCertificates(tx, [pinnedId], { reason: REMOVED_REASON })
    }
    return true
  })
}

/**
 * True when every name of the hosting is a locked tunnel name (nothing public
 * can use a certificate for it); in that case a Let's Encrypt row made for the
 * site is released first. False leaves everything as it was.
 */
export async function settleTunnelOnlyHosting(
  db: Db,
  params: { organizationId: string; hostingId: string }
): Promise<boolean> {
  const [site] = await db
    .select({ options: hosting.options })
    .from(hosting)
    .where(eq(hosting.id, params.hostingId))
    .limit(1)
  if (!site) return false
  const options = parseHostingOptions(site.options)
  const tunnelOnly = await isTunnelOnlyHosting(db, {
    organizationId: params.organizationId,
    hostingId: params.hostingId,
    siteHostnames: options?.hostnames ?? [],
    www: readHostingWwwMode(site.options),
  })
  if (!tunnelOnly) return false
  await releaseSitePin(db, params.hostingId, params.organizationId)
  return true
}
