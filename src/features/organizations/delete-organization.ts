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
 * keep failing. `DELETE /organizations/:id` is the one production caller, through
 * {@link deleteOrganizationIfClear}: it refuses while the organization still has a
 * server, a tunnel or a DNS record ({@link organizationDeleteBlockers}), because those
 * are or point at resources outside the database that this delete would orphan.
 */
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  audit,
  badge,
  carrier,
  dnsRecord,
  grant,
  organization,
  project,
  secret,
  server,
  storage,
  storageCopy,
  team,
  tunnel,
  workspace,
} from '../../db/schema.ts'
import type { AuditEntry } from '../audit/audit-records.ts'

/** What still stands between an organization and its delete. */
export type OrganizationDeleteBlockers = {
  /** Servers of the organization; they are purged or removed one by one first, never moved. */
  servers: number
  /** Tunnels the organization owns, routes through or holds on its carriers; each is a tunnel at the provider. */
  tunnels: number
  /** DNS records of the organization or on its carriers; each is a record at the provider. */
  dnsRecords: number
}

/** The organization's carriers, as a subquery. */
function carriersOf(db: Db, organizationId: string) {
  return db
    .select({ id: carrier.id })
    .from(carrier)
    .where(eq(carrier.organizationId, organizationId))
}

/** The tunnel rows this delete removes (and so the rows that block it). */
function tunnelScope(db: Db, organizationId: string): SQL {
  return or(
    eq(tunnel.organizationId, organizationId),
    eq(tunnel.routingOrganizationId, organizationId),
    inArray(tunnel.carrierId, carriersOf(db, organizationId))
  )!
}

/** The DNS record rows this delete removes (and so the rows that block it). */
function dnsRecordScope(db: Db, organizationId: string): SQL {
  return or(
    eq(dnsRecord.organizationId, organizationId),
    inArray(dnsRecord.carrierId, carriersOf(db, organizationId))
  )!
}

/** Counts of the rows that block a delete, in one round trip. */
export async function organizationDeleteBlockers(
  db: Db,
  organizationId: string
): Promise<OrganizationDeleteBlockers> {
  const [row] = await db
    .select({
      servers: sql<number>`(select count(*)::int from ${server} where ${server.organizationId} = ${organizationId})`,
      tunnels: sql<number>`(select count(*)::int from ${tunnel} where ${tunnelScope(db, organizationId)})`,
      dnsRecords: sql<number>`(select count(*)::int from ${dnsRecord} where ${dnsRecordScope(db, organizationId)})`,
    })
    .from(sql`(select 1) as one`)
  return row ?? { servers: 0, tunnels: 0, dnsRecords: 0 }
}

/** The cascade, inside the caller's transaction. */
async function removeOrganizationRows(tx: Db, organizationId: string): Promise<void> {
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
  const teams = tx.select({ id: team.id }).from(team).where(eq(team.organizationId, organizationId))
  const workspaces = tx
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.organizationId, organizationId))
  const projects = tx
    .select({ id: project.id })
    .from(project)
    .where(eq(project.organizationId, organizationId))

  await tx.delete(dnsRecord).where(dnsRecordScope(tx, organizationId))
  await tx.delete(tunnel).where(tunnelScope(tx, organizationId))
  await tx
    .delete(badge)
    .where(
      or(inArray(badge.carrierId, carriersOf(tx, organizationId)), inArray(badge.secretId, secrets))
    )
  await tx
    .delete(storageCopy)
    .where(
      or(
        inArray(storageCopy.storageId, storages),
        inArray(storageCopy.secretId, secrets),
        inArray(storageCopy.serverId, servers)
      )
    )
  // `permission` rows name their entity and actor by id with no foreign key, so the
  // cascade cannot reach them: remove what points at this organization's own rows.
  await tx
    .delete(grant)
    .where(
      or(
        and(eq(grant.entityType, 'organization'), eq(grant.entityId, organizationId)),
        and(eq(grant.actorType, 'organization'), eq(grant.actorId, organizationId)),
        and(eq(grant.entityType, 'team'), inArray(grant.entityId, teams)),
        and(eq(grant.actorType, 'team'), inArray(grant.actorId, teams)),
        and(eq(grant.entityType, 'workspace'), inArray(grant.entityId, workspaces)),
        and(eq(grant.entityType, 'project'), inArray(grant.entityId, projects))
      )
    )
  await tx.delete(organization).where(eq(organization.id, organizationId))
}

/** Delete the organization and everything it owns in one transaction, with no pre-checks. */
export async function deleteOrganization(db: Db, organizationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await removeOrganizationRows(tx, organizationId)
  })
}

export type DeleteOrganizationResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'blocked'; blockers: OrganizationDeleteBlockers }

/**
 * The guarded delete behind `DELETE /organizations/:id`. It locks the organization row
 * (`FOR UPDATE`, which also holds off a server or tunnel being added through its foreign
 * key), re-counts the blockers under that lock, and only then removes the rows and writes
 * `audit` in the same transaction, so a delete never lands without its trail and a
 * concurrent insert answers 409 instead of failing on a foreign key.
 */
export async function deleteOrganizationIfClear(
  db: Db,
  organizationId: string,
  auditEntry: AuditEntry
): Promise<DeleteOrganizationResult> {
  return await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .for('update')
    if (locked.length === 0) return { status: 'not_found' }
    const blockers = await organizationDeleteBlockers(tx, organizationId)
    if (blockers.servers > 0 || blockers.tunnels > 0 || blockers.dnsRecords > 0) {
      return { status: 'blocked', blockers }
    }
    await removeOrganizationRows(tx, organizationId)
    await tx.insert(audit).values({
      organizationId: null,
      actorUserId: auditEntry.actorUserId ?? null,
      actorEmail: auditEntry.actorEmail ?? null,
      action: auditEntry.action,
      targetType: auditEntry.targetType,
      targetId: auditEntry.targetId ?? null,
      context: auditEntry.context ?? null,
    })
    return { status: 'deleted' }
  })
}
