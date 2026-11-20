/**
 * Let's Encrypt via HTTP, per name. A name saved with that choice and no pin
 * gets a managed certificate row of its own (one per name, found or created
 * under the organization's Let's Encrypt lock like the whole-site button does)
 * and pins it with `hostname.tls_id`. The HTTP sweep
 * (`client/tls/http-issuance-sweep.ts`) picks up every automatic row a name
 * pins, so the order, its daily cap and its rate limiting are the existing
 * ones; nothing is ordered from here.
 *
 * One row per name, not one per site: a name's order succeeds, fails and
 * renews on its own, so a name that does not point here yet never holds back
 * the others, and moving one name to another choice touches no other name. The
 * cost is one new certificate per name against the organization's daily cap.
 *
 * Only names stored as `letsencrypt_http` with no pin are handled, so a name
 * that pins a library row (a Let's Encrypt row included) keeps renewing through
 * that row, and a name already holding its own row is left alone. A name moved
 * to another choice loses the pin through the save; the row it leaves is
 * removed when its order never began, and otherwise stays unpinned, which the
 * sweep does not pick up, so it stops retrying.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, hostname, hosting, service } from '../../db/schema.ts'
import { readHostingComposeOwner } from '../../features/hostings/hosting-compose-owner.ts'
import {
  parseHostingOptions,
  resolveHostingBind,
  resolveHostingProtocol,
} from '../../features/hostings/hosting-options.ts'
import { httpReason } from '../../features/hostings/name-certificate-options.ts'
import { lockOrganizationLetsEncrypt } from '../../features/tls/unused-letsencrypt.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { loadAcmeEnabled, managedCertificateFor } from './letsencrypt-store.ts'

/**
 * Give every name of the hosting that is set to Let's Encrypt via HTTP, holds
 * no pin and passes the HTTP check a row of its own. Run inside the
 * transaction of the save, after the names are written. Returns the names that
 * were pinned.
 */
export async function ensureNameHttpOrders(
  tx: Db,
  hostingId: string,
  organizationId: string
): Promise<string[]> {
  const waiting = await tx
    .select({ name: hostname.hostname })
    .from(hostname)
    .where(
      and(
        eq(hostname.hostingId, hostingId),
        eq(hostname.certificate, 'letsencrypt_http'),
        isNull(hostname.tlsId)
      )
    )
  if (waiting.length === 0) return []
  const [site] = await tx
    .select({ options: hosting.options, metadata: hosting.metadata })
    .from(hosting)
    .where(eq(hosting.id, hostingId))
    .limit(1)
  // A compose-owned site gets its certificate from its compose file.
  if (!site || readHostingComposeOwner(site.metadata) !== null) return []
  const options = parseHostingOptions(site.options)
  const facts = {
    acmeEnabled: await loadAcmeEnabled(tx, organizationId),
    isHttp: resolveHostingProtocol(options) === 'http',
    bind: resolveHostingBind(options),
  }
  const eligible = waiting.filter(({ name }) => httpReason({ ...facts, hostname: name }) === null)
  if (eligible.length === 0) return []
  // The order a deploy takes the locks in: the environment row, then the organization's.
  await tx
    .select({ id: environment.id })
    .from(environment)
    .innerJoin(service, eq(service.environmentId, environment.id))
    .innerJoin(hosting, eq(hosting.serviceId, service.id))
    .where(eq(hosting.id, hostingId))
    .for('update', { of: environment })
  await lockOrganizationLetsEncrypt(tx, organizationId)
  const pinned: string[] = []
  await forEachSequential(eligible, async ({ name }) => {
    const { id } = await managedCertificateFor(tx, organizationId, [name])
    await tx
      .update(hostname)
      .set({ tlsId: id })
      .where(
        and(
          eq(hostname.hostingId, hostingId),
          eq(hostname.hostname, name),
          eq(hostname.certificate, 'letsencrypt_http'),
          isNull(hostname.tlsId)
        )
      )
    pinned.push(name)
  })
  return pinned
}
