import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { resource } from '../db/schema.ts'

export type RegisterResourceInput = {
  kind: string
  itemId: string
  organizationId: string
  /** `resource.id` of the parent resource (not the parent entity's own id). */
  parentId?: string | null
}

export type ResourceRow = typeof resource.$inferSelect

/**
 * Idempotently register (or refresh) a resource row for an entity.
 * Conflicts on the `resource_kind_item_unique` constraint (`kind`, `item_id`)
 * bump `updated_at`. Returns the resolved `resource.id`.
 */
export async function registerResource(
  db: Db,
  { kind, itemId, organizationId, parentId }: RegisterResourceInput,
): Promise<string> {
  const [row] = await db
    .insert(resource)
    .values({
      kind,
      itemId,
      organizationId,
      parentId: parentId ?? null,
    })
    .onConflictDoUpdate({
      target: [resource.kind, resource.itemId],
      set: {
        updatedAt: sql`now()`,
        organizationId: sql`excluded.organization_id`,
        parentId: sql`excluded.parent_id`,
      },
    })
    .returning({ id: resource.id })

  if (!row) {
    throw new Error(`resource upsert returned no row for ${kind}:${itemId}`)
  }

  return row.id
}

/**
 * Delete the resource row for an entity. Child resources cascade via the
 * `resource_parent_org_fk` foreign key.
 */
export async function unregisterResource(
  db: Db,
  kind: string,
  itemId: string,
): Promise<void> {
  await db
    .delete(resource)
    .where(and(eq(resource.kind, kind), eq(resource.itemId, itemId)))
}

/** Return the full `resource` row for an entity, or `null` when not found. */
export async function getResourceByItem(
  db: Db,
  kind: string,
  itemId: string,
): Promise<ResourceRow | null> {
  const [row] = await db
    .select()
    .from(resource)
    .where(and(eq(resource.kind, kind), eq(resource.itemId, itemId)))
    .limit(1)

  return row ?? null
}

/** Thin wrapper over {@link getResourceByItem} returning just the `id`. */
export async function getResourceId(
  db: Db,
  kind: string,
  itemId: string,
): Promise<string | null> {
  const row = await getResourceByItem(db, kind, itemId)
  return row?.id ?? null
}
