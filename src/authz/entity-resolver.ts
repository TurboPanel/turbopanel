import { eq } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { organization } from '../db/schema.ts'
import { RESOURCE_KINDS } from './catalog.ts'
import { resolveEntityOrganizationId } from './create-access-grant.ts'

export type ResolvedEntity = {
  entityType: string
  entityId: string
  organizationId: string
}

function isResourceKind(value: string): boolean {
  return (RESOURCE_KINDS as readonly string[]).includes(value)
}

/**
 * Resolve an entity from its primary-key UUID. After the `resource` registry
 * table was removed, client `resourceId` values are the entity UUID itself.
 */
export async function resolveEntityById(
  db: Db,
  entityId: string,
): Promise<ResolvedEntity | null> {
  for (const entityType of RESOURCE_KINDS) {
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
  if (!isResourceKind(kind)) {
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
