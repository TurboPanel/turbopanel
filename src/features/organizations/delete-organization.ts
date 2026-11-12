/**
 * Delete an organization and everything it owns, in an order the database
 * accepts, inside one transaction.
 *
 * Five foreign keys are plain NO ACTION or RESTRICT and point at rows the
 * organization delete cascades through, and Postgres checks them for each
 * cascaded statement, so a bare `delete from organization` fails whenever the
 * organization holds a row on the wrong side of one of them:
 *
 * - `record.carrier_id`, `tunnel.carrier_id` and `badge.carrier_id` hang on a
 *   carrier;
 * - `badge.secret_id` and `copy.secret_id` hang on a secret;
 * - `copy.server_id` hangs on a server.
 *
 * The rows that hold those keys are removed first (records, tunnels, badges,
 * copies); the cascade then finds nothing in its way. The keys stay immediate
 * on purpose: deleting one secret or carrier that something still names must
 * keep failing, and no production path deletes an organization today (this is
 * the tested way for a path that will).
 */
import { eq, inArray, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  badge,
  carrier,
  dnsRecord,
  organization,
  secret,
  server,
  storage,
  storageCopy,
  tunnel,
} from '../../db/schema.ts'

export async function deleteOrganization(db: Db, organizationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const carriers = tx
      .select({ id: carrier.id })
      .from(carrier)
      .where(eq(carrier.organizationId, organizationId))
    const secrets = tx
      .select({ id: secret.id })
      .from(secret)
      .where(eq(secret.organizationId, organizationId))
    const storages = tx
      .select({ id: storage.id })
      .from(storage)
      .where(eq(storage.organizationId, organizationId))
    const servers = tx
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, organizationId))

    await tx
      .delete(dnsRecord)
      .where(
        or(eq(dnsRecord.organizationId, organizationId), inArray(dnsRecord.carrierId, carriers))
      )
    await tx
      .delete(tunnel)
      .where(
        or(
          eq(tunnel.organizationId, organizationId),
          eq(tunnel.routingOrganizationId, organizationId),
          inArray(tunnel.carrierId, carriers)
        )
      )
    await tx
      .delete(badge)
      .where(or(inArray(badge.carrierId, carriers), inArray(badge.secretId, secrets)))
    await tx
      .delete(storageCopy)
      .where(
        or(
          inArray(storageCopy.storageId, storages),
          inArray(storageCopy.secretId, secrets),
          inArray(storageCopy.serverId, servers)
        )
      )
    await tx.delete(organization).where(eq(organization.id, organizationId))
  })
}
