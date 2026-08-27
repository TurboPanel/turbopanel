import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { nowIso } from '../commands/ids.ts'
import { isValidDisplayName, normalizeDisplayName } from '../display-name-format.ts'
import { marker, tag } from './schema.ts'

export const TAGGABLE_PARENTS = [
  { bodyKey: 'serverId', column: 'serverId', entityKind: 'server' },
  { bodyKey: 'workspaceId', column: 'workspaceId', entityKind: 'workspace' },
  { bodyKey: 'projectId', column: 'projectId', entityKind: 'project' },
  { bodyKey: 'environmentId', column: 'environmentId', entityKind: 'environment' },
  { bodyKey: 'serviceId', column: 'serviceId', entityKind: 'service' },
  { bodyKey: 'datacenterId', column: 'datacenterId', entityKind: 'datacenter' },
  { bodyKey: 'storageId', column: 'storageId', entityKind: 'storage' },
] as const

export type TaggableParentColumn = typeof TAGGABLE_PARENTS[number]['column']
export type TaggableEntityKind = typeof TAGGABLE_PARENTS[number]['entityKind']

export type ParsedTagParent = {
  column: TaggableParentColumn
  id: string
  entityKind: TaggableEntityKind
}

type MarkerDbRow = typeof marker.$inferSelect

export type TagRecord = {
  id: string
  organizationId: string
  name: string
  description: string | null
  color: string | null
  createdAt: string
  updatedAt: string
}

export type MarkerRecord = {
  id: string
  tagId: string
  createdAt: string
} & {
  [K in TaggableParentColumn]?: string
}

const TAG_SELECT = {
  id: tag.id,
  organizationId: tag.organizationId,
  name: tag.name,
  description: tag.description,
  color: tag.color,
  createdAt: tag.createdAt,
  updatedAt: tag.updatedAt,
}

const TAG_UNIQUE_INDEX = 'uniq_tag_organization_name'

export type ParseTagNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string }

/** Parse/normalize a tag label. Schema has no name-format CHECK. */
export function parseTagNameInput(value: unknown): ParseTagNameResult {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Invalid request' }
  }
  const name = normalizeDisplayName(value)
  if (!isValidDisplayName(name)) {
    return { ok: false, error: 'Invalid request' }
  }
  return { ok: true, name }
}

function requireTagName(value: unknown): string {
  const parsed = parseTagNameInput(value)
  if (!parsed.ok) {
    throw new TypeError(parsed.error)
  }
  return parsed.name
}

export function serializeTag(row: TagRecord): TagRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description,
    color: row.color,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function serializeMarker(row: MarkerDbRow): MarkerRecord {
  const record: MarkerRecord = {
    id: row.id,
    tagId: row.tagId,
    createdAt: row.createdAt,
  }
  for (const { column } of TAGGABLE_PARENTS) {
    const value = row[column]
    if (value) {
      record[column] = value
    }
  }
  return record
}

function sortTagRecords(records: TagRecord[]): TagRecord[] {
  return [...records].sort((a, b) => a.name.localeCompare(b.name))
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

export function isTagUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(TAG_UNIQUE_INDEX)
}

export async function listOrganizationTags(
  db: Db,
  organizationId: string,
): Promise<TagRecord[]> {
  const rows = await db
    .select()
    .from(tag)
    .where(eq(tag.organizationId, organizationId))

  return sortTagRecords(rows.map(serializeTag))
}

export async function listTagsForEntity(
  db: Db,
  column: TaggableParentColumn,
  entityId: string,
): Promise<TagRecord[]> {
  const rows = await db
    .select(TAG_SELECT)
    .from(marker)
    .innerJoin(tag, eq(marker.tagId, tag.id))
    .where(eq(marker[column], entityId))

  return sortTagRecords(rows.map(serializeTag))
}

export async function listTagsForEntities(
  db: Db,
  column: TaggableParentColumn,
  entityIds: readonly string[],
): Promise<Map<string, TagRecord[]>> {
  const result = new Map<string, TagRecord[]>()
  if (entityIds.length === 0) return result

  const rows = await db
    .select({
      ...TAG_SELECT,
      entityId: marker[column],
    })
    .from(marker)
    .innerJoin(tag, eq(marker.tagId, tag.id))
    .where(inArray(marker[column], [...entityIds]))

  for (const row of rows) {
    const entityId = row.entityId
    if (!entityId) continue
    const record = serializeTag(row)
    const list = result.get(entityId)
    if (list) {
      list.push(record)
    } else {
      result.set(entityId, [record])
    }
  }

  for (const [entityId, records] of result) {
    result.set(entityId, sortTagRecords(records))
  }
  return result
}

export async function listMarkersForTag(
  db: Db,
  tagId: string,
): Promise<MarkerRecord[]> {
  const rows = await db
    .select()
    .from(marker)
    .where(eq(marker.tagId, tagId))

  return rows.map(serializeMarker)
}

export async function createTag(
  db: Db,
  values: {
    organizationId: string
    name: string
    description: string | null
    color: string | null
  },
): Promise<string> {
  const name = requireTagName(values.name)
  const [inserted] = await db
    .insert(tag)
    .values({
      organizationId: values.organizationId,
      name,
      description: values.description,
      color: values.color,
      updatedAt: nowIso(),
    })
    .returning({ id: tag.id })

  if (!inserted) {
    throw new TypeError('tag insert returned no row')
  }
  return inserted.id
}

export type TagUpdateFields = {
  name?: string
  description?: string | null
  color?: string | null
  updatedAt: string
}

export async function updateTag(
  db: Db,
  id: string,
  fields: TagUpdateFields,
): Promise<void> {
  const patch: TagUpdateFields = { ...fields }
  if (patch.name !== undefined) {
    patch.name = requireTagName(patch.name)
  }
  await db.update(tag).set(patch).where(eq(tag.id, id))
}

export async function deleteTag(db: Db, id: string): Promise<void> {
  await db.delete(tag).where(eq(tag.id, id))
}

export async function setEntityTags(
  db: Db,
  column: TaggableParentColumn,
  entityId: string,
  tagIds: readonly string[],
): Promise<TagRecord[]> {
  return db.transaction(async (tx) => {
    const now = nowIso()
    for (const tagId of tagIds) {
      await tx
        .insert(marker)
        .values({
          tagId,
          [column]: entityId,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [marker.tagId, marker[column]],
          where: sql`${marker[column]} IS NOT NULL`,
        })
    }

    if (tagIds.length === 0) {
      await tx.delete(marker).where(eq(marker[column], entityId))
    } else {
      await tx
        .delete(marker)
        .where(
          and(eq(marker[column], entityId), notInArray(marker.tagId, [...tagIds])),
        )
    }

    return listTagsForEntity(tx, column, entityId)
  })
}
