import type { Context } from 'hono'
import type { Db } from '../db.ts'

/** foreign_key_violation — typical for ON DELETE NO ACTION */
const POSTGRES_FK_VIOLATION = '23503'
/** restrict_violation — raised immediately by ON DELETE RESTRICT */
const POSTGRES_RESTRICT_VIOLATION = '23001'

export const HIERARCHY_DELETE_HAS_CHILDREN_ERROR =
  'Cannot delete while child resources exist'

function getPostgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  if (typeof record.code === 'string') return record.code
  if (record.cause && record.cause !== error) {
    return getPostgresErrorCode(record.cause)
  }
  return undefined
}

export function isForeignKeyViolation(error: unknown): boolean {
  const code = getPostgresErrorCode(error)
  return code === POSTGRES_FK_VIOLATION || code === POSTGRES_RESTRICT_VIOLATION
}

export async function runHierarchyDelete(
  db: Db,
  deleteOp: (tx: Db) => Promise<void>,
): Promise<'ok' | 'has_children'> {
  try {
    await db.transaction(deleteOp)
    return 'ok'
  } catch (error) {
    if (isForeignKeyViolation(error)) return 'has_children'
    throw error
  }
}

export function hierarchyDeleteHasChildrenResponse(c: Context): Response {
  return c.json({ error: HIERARCHY_DELETE_HAS_CHILDREN_ERROR }, 409)
}
