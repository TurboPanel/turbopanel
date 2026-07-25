import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import { ENTITY_TYPES, isGrantEntityType } from './catalog.ts'
import { resolveEntityOrganizationId, verifyEntityExists } from './create-access-grant.ts'

export type ResolvedEntity = {
  entityType: string
  entityId: string
  organizationId: string
}

/**
 * Resolve an entity from its primary-key UUID. After the `resource` registry
 * table was removed, client `resourceId` values are the entity UUID itself.
 */
export async function resolveEntityById(
  db: Db,
  entityId: string,
): Promise<ResolvedEntity | null> {
  for (const entityType of ENTITY_TYPES) {
    if (!(await verifyEntityExists(db, entityType, entityId))) {
      continue
    }

    const organizationId = await resolveEntityOrganizationId(db, entityType, entityId)
    if (organizationId !== null) {
      return { entityType, entityId, organizationId }
    }
  }
  return null
}

/** Resolve a scoped entity by kind + item id (used by `/access/resource-id`). */
export async function resolveEntityByKindAndItemId(
  db: Db,
  kind: string,
  itemId: string,
): Promise<ResolvedEntity | null> {
  if (!isGrantEntityType(kind)) {
    return null
  }

  const organizationId = await resolveEntityOrganizationId(db, kind, itemId)
  if (organizationId === null) {
    return null
  }

  return { entityType: kind, entityId: itemId, organizationId }
}

/** Confirm an organization row exists (billing fallback when org entity is missing). */
export async function organizationExists(
  db: Db,
  organizationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return rows.length > 0
}
