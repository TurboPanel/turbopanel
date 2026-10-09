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

/** Result of {@link runHierarchyDelete} (string form keeps legacy call sites unchanged). */
export type HierarchyDeleteResult = 'ok' | 'has_children'

let lastHierarchyDeleteFkViolation: HierarchyDeleteFkViolation | undefined

/** FK detail from the most recent `has_children` result; cleared on the next delete run. */
export function peekHierarchyDeleteFkViolation(): HierarchyDeleteFkViolation | undefined {
  return lastHierarchyDeleteFkViolation
}

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

function referringTableFromErrorLayer(layer: Record<string, unknown>): string | undefined {
  if (typeof layer.table_name === 'string') return layer.table_name
  if (typeof layer.constraint_name === 'string') {
    return referringTableFromConstraintName(layer.constraint_name)
  }
  return undefined
}

export function parsePostgresForeignKeyViolation(
  error: unknown
): HierarchyDeleteFkViolation | null {
  let current: unknown = error
  while (current && typeof current === 'object') {
    const layer = current as Record<string, unknown>
    const code = layer.code
    if (code === POSTGRES_FK_VIOLATION || code === POSTGRES_RESTRICT_VIOLATION) {
      const tableName = referringTableFromErrorLayer(layer)
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
  lastHierarchyDeleteFkViolation = undefined
  try {
    await db.transaction(deleteOp)
    return 'ok'
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error
    const violation = parsePostgresForeignKeyViolation(error)
    lastHierarchyDeleteFkViolation = violation ?? { referringTable: 'child resources' }
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
    return 'has_children'
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

/** When delete hit a child FK, return the 409 response; otherwise `null`. */
export function hierarchyDeleteHasChildrenResponseIfNeeded(
  c: Context,
  result: HierarchyDeleteResult
): Response | null {
  if (result !== 'has_children') return null
  return hierarchyDeleteHasChildrenResponse(c, peekHierarchyDeleteFkViolation())
}
