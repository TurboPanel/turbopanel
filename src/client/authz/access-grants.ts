import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { grant } from '../../lib/db/schema.ts'

export type AccessRecord = {
  id: string
  subjectKind: 'user' | 'team' | 'organization'
  subjectId: string
  resourceId: string
  effect: 'allow' | 'deny'
  permissionKey: string
}

type AtomicGrantRow = {
  id: string
  entityType: string
  entityId: string
  actorType: string
  actorId: string
  permission: string
  allow: boolean
}

/** Map atomic `grant` rows to access API records. */
export function mapGrantRows(rows: AtomicGrantRow[]): AccessRecord[] {
  return rows.map((row) => ({
    id: row.id,
    subjectKind: row.actorType as AccessRecord['subjectKind'],
    subjectId: row.actorId,
    resourceId: row.entityId,
    effect: row.allow ? 'allow' : 'deny',
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

export function mapEffectToAllowed(effect: 'allow' | 'deny'): boolean {
  return effect === 'allow'
}
