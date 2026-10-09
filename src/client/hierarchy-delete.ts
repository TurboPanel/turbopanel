import type { Context } from 'hono'
import type { Db } from '../db/connection.ts'
import { compatLogWarn } from '../lib/log-compat.ts'
import { referringTableFromConstraintName } from './servers/server-fk.ts'

/** foreign_key_violation — typical for ON DELETE NO ACTION */
const POSTGRES_FK_VIOLATION = '23503'
/** restrict_violation — raised immediately by ON DELETE RESTRICT */
const POSTGRES_RESTRICT_VIOLATION = '23001'

export const HIERARCHY_DELETE_HAS_CHILDREN_ERROR = 'Cannot delete while child resources exist'

export const HIERARCHY_DELETE_HAS_CHILDREN_CODE = 'hierarchy_delete_has_children'

export type HierarchyDeleteFkViolation = {
  referringTable: string
  constraintName?: string
}

export type HierarchyDeleteResult =
  { status: 'ok' } | { status: 'has_children'; violation: HierarchyDeleteFkViolation }

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

export function parsePostgresForeignKeyViolation(
  error: unknown
): HierarchyDeleteFkViolation | null {
  let current: unknown = error
  while (current && typeof current === 'object') {
    const layer = current as Record<string, unknown>
    const code = layer.code
    if (code === POSTGRES_FK_VIOLATION || code === POSTGRES_RESTRICT_VIOLATION) {
      const tableName =
        typeof layer.table_name === 'string'
          ? layer.table_name
          : typeof layer.constraint_name === 'string'
            ? referringTableFromConstraintName(layer.constraint_name)
            : undefined
      const constraintName =
        typeof layer.constraint_name === 'string' ? layer.constraint_name : undefined
      if (tableName) {
        return { referringTable: tableName, ...(constraintName ? { constraintName } : {}) }
      }
      if (constraintName) {
        const fromConstraint = referringTableFromConstraintName(constraintName)
        if (fromConstraint) {
          return { referringTable: fromConstraint, constraintName }
        }
      }
      return null
    }
    if (layer.cause && layer.cause !== current) {
      current = layer.cause
      continue
    }
    break
  }
  return null
}

export function hierarchyDeleteHasChildrenMessage(violation?: HierarchyDeleteFkViolation): string {
  if (violation?.referringTable) {
    return `Something still refers to this server: ${violation.referringTable}`
  }
  return HIERARCHY_DELETE_HAS_CHILDREN_ERROR
}

export async function runHierarchyDelete(
  db: Db,
  deleteOp: (tx: Db) => Promise<void>
): Promise<HierarchyDeleteResult> {
  try {
    await db.transaction(deleteOp)
    return { status: 'ok' }
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error
    const violation = parsePostgresForeignKeyViolation(error)
    if (violation?.constraintName) {
      compatLogWarn(
        'hierarchy-delete',
        `server delete blocked by FK ${violation.constraintName} (${violation.referringTable})`
      )
    } else if (violation?.referringTable) {
      compatLogWarn(
        'hierarchy-delete',
        `server delete blocked by FK on ${violation.referringTable}`
      )
    }
    return {
      status: 'has_children',
      violation: violation ?? { referringTable: 'child resources' },
    }
  }
}

export function hierarchyDeleteHasChildrenResponse(
  c: Context,
  violation?: HierarchyDeleteFkViolation
): Response {
  return c.json(
    {
      error: hierarchyDeleteHasChildrenMessage(violation),
      code: HIERARCHY_DELETE_HAS_CHILDREN_CODE,
    },
    409
  )
}
