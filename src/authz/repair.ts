import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { organization, resource, server } from '../db/schema.ts'
import { registerResource } from './resource-registry.ts'

/**
 * Ensure every organization has a corresponding `resource` row. Idempotent —
 * safe to run on every catalog sync / migrate.
 */
export async function repairOrganizationResources(db: Db): Promise<number> {
  const orgs = await db
    .select({ id: organization.id })
    .from(organization)

  let repaired = 0
  for (const org of orgs) {
    const existing = await db
      .select({ id: resource.id })
      .from(resource)
      .where(and(eq(resource.kind, 'organization'), eq(resource.itemId, org.id)))
      .limit(1)

    if (existing.length > 0) continue

    await registerResource(db, {
      kind: 'organization',
      itemId: org.id,
      organizationId: org.id,
    })
    repaired++
  }

  return repaired
}

/**
 * Point server `resource.parent_id` at the organization resource and register
 * missing server resources for org-assigned servers. Idempotent.
 */
export async function repairServerResourceParents(db: Db): Promise<number> {
  const assigned = await db
    .select({
      serverId: server.id,
      organizationId: server.organizationId,
    })
    .from(server)
    .where(and(isNull(server.deletedAt), sql`${server.organizationId} IS NOT NULL`))

  let repaired = 0
  for (const row of assigned) {
    const organizationId = row.organizationId!
    const orgResourceId = await db
      .select({ id: resource.id })
      .from(resource)
      .where(and(
        eq(resource.kind, 'organization'),
        eq(resource.itemId, organizationId),
      ))
      .limit(1)

    const parentId = orgResourceId[0]?.id
    if (!parentId) continue

    const serverResource = await db
      .select({ id: resource.id, parentId: resource.parentId })
      .from(resource)
      .where(and(eq(resource.kind, 'server'), eq(resource.itemId, row.serverId)))
      .limit(1)

    if (serverResource.length === 0) {
      await registerResource(db, {
        kind: 'server',
        itemId: row.serverId,
        organizationId,
        parentId,
      })
      repaired++
      continue
    }

    if (serverResource[0]?.parentId !== parentId) {
      await db
        .update(resource)
        .set({ parentId, updatedAt: sql`now()` })
        .where(eq(resource.id, serverResource[0]!.id))
      repaired++
    }
  }

  return repaired
}

/** One-time repair path for missing org resources and server parent links. */
export async function repairResourceRegistry(db: Db): Promise<void> {
  const orgRepaired = await repairOrganizationResources(db)
  const serverRepaired = await repairServerResourceParents(db)

  if (orgRepaired > 0 || serverRepaired > 0) {
    console.log(
      `[authz] resource registry repaired: ${orgRepaired} org resource(s), ${serverRepaired} server parent link(s)`,
    )
  }
}
