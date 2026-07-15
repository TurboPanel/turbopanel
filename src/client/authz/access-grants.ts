import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { grant } from '../../lib/db/schema.ts'

/**
 * Deny grants are not supported: authorization evaluation only considers
 * `allow = true` rows (see `evaluator.ts`), so `effect` is always `'allow'`.
 * A `deny` value would be silently ignored by the checks, so it is rejected at
 * the API boundary rather than accepted and displayed.
 */
export type AccessRecord = {
  id: string
  subjectKind: 'user' | 'team' | 'organization'
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
  allow: boolean
}

/**
 * Map atomic `grant` rows to access API records. Only `allow` rows are
 * surfaced — deny grants are unsupported and never authoritative, so any
 * legacy non-allow row is excluded rather than misrepresented.
 */
export function mapGrantRows(rows: AtomicGrantRow[]): AccessRecord[] {
  return rows
    .filter((row) => row.allow)
    .map((row) => ({
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
