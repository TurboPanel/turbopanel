import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { grant } from '../../lib/db/schema.ts'
import type { SubjectType } from './catalog.ts'

/**
 * Every persisted grant is allow-only. Authorization evaluation treats each
 * row as a positive capability grant (see `evaluator.ts`); deny semantics are
 * not part of the model. The API still exposes `effect: 'allow'` for the
 * stable client DTO shape.
 */
export type AccessRecord = {
  id: string
  subjectKind: SubjectType
  subjectId: string
  resourceId: string
  effect: 'allow'
  permissionKey: string
}

type AtomicGrantRow = {
  id: string
  entityType: string
  entityId: string
  actorType: string
  actorId: string
  permission: string
}

/** Map atomic `grant` rows to access API records (all grants are allow). */
export function mapGrantRows(rows: AtomicGrantRow[]): AccessRecord[] {
  return rows.map((row) => ({
    id: row.id,
    subjectKind: row.actorType as AccessRecord['subjectKind'],
    subjectId: row.actorId,
    resourceId: row.entityId,
    effect: 'allow' as const,
    permissionKey: row.permission,
  }))
}

/** Delete a single access grant row by id. */
export async function revokeAccessGrant(db: Db, accessId: string): Promise<boolean> {
  const deleted = await db
    .delete(grant)
    .where(eq(grant.id, accessId))
    .returning({ id: grant.id })

  return deleted.length > 0
}
