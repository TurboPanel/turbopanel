import type { Context } from 'hono'
import type { Db } from '../db/connection.ts'
import { compatLogWarn } from '../lib/log-compat.ts'
import { referringTableFromConstraintName } from './servers/server-fk.ts'

/** foreign_key_violation — typical for ON DELETE NO ACTION */
const POSTGRES_FK_VIOLATION = '23503'
/** restrict_violation — raised immediately by ON DELETE RESTRICT */
const POSTGRES_RESTRICT_VIOLATION = '23001'

const REFERENCED_FROM_TABLE_RE = /referenced from table "([^"]+)"/i

export const HIERARCHY_DELETE_HAS_CHILDREN_ERROR = 'Cannot delete while child resources exist'

export const HIERARCHY_DELETE_HAS_CHILDREN_CODE = 'hierarchy_delete_has_children'

/** One FK row that still points at the deleted parent (no tenant ids). */
export type HierarchyDeleteFkBlocker = {
  table: string
  constraint?: string
  column?: string
}

export type HierarchyDeleteRunResult =
  { status: 'ok' } | { status: 'has_children'; blockers: HierarchyDeleteFkBlocker[] }

function readStringField(layer: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = layer[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
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

function tableFromConstraintName(constraintName: string): string | undefined {
  return referringTableFromConstraintName(constraintName)
}

function tableFromDetail(detail: string): string | undefined {
  const match = REFERENCED_FROM_TABLE_RE.exec(detail)
  return match?.[1]
}

function hierarchyDeleteFkBlockerFromLayer(
  layer: Record<string, unknown>
): HierarchyDeleteFkBlocker | null {
  const code = layer.code
  if (code !== POSTGRES_FK_VIOLATION && code !== POSTGRES_RESTRICT_VIOLATION) {
    return null
  }

  const constraint = readStringField(layer, 'constraint_name', 'constraint') ?? undefined
  const column = readStringField(layer, 'column_name', 'column') ?? undefined

  const tableName =
    readStringField(layer, 'table_name', 'table') ??
    (constraint ? tableFromConstraintName(constraint) : undefined) ??
    (typeof layer.detail === 'string' ? tableFromDetail(layer.detail) : undefined)

  if (!tableName) {
    if (constraint) {
      return { table: 'unknown', constraint, ...(column ? { column } : {}) }
    }
    return null
  }

  return {
    table: tableName,
    ...(constraint ? { constraint } : {}),
    ...(column ? { column } : {}),
  }
}

export function parsePostgresForeignKeyViolation(error: unknown): HierarchyDeleteFkBlocker | null {
  let current: unknown = error
  while (current && typeof current === 'object') {
    const layer = current as Record<string, unknown>
    const blocker = hierarchyDeleteFkBlockerFromLayer(layer)
    if (blocker) return blocker
    if (layer.code === POSTGRES_FK_VIOLATION || layer.code === POSTGRES_RESTRICT_VIOLATION) {
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

export function hierarchyDeleteHasChildrenMessage(): string {
  return HIERARCHY_DELETE_HAS_CHILDREN_ERROR
}

export function hierarchyDeleteFkBlockersFromViolation(
  violation: HierarchyDeleteFkBlocker | null | undefined
): HierarchyDeleteFkBlocker[] {
  if (!violation?.table) return []
  return [violation]
}

export async function runHierarchyDelete(
  db: Db,
  deleteOp: (tx: Db) => Promise<void>
): Promise<HierarchyDeleteRunResult> {
  try {
    await db.transaction(deleteOp)
    return { status: 'ok' }
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error
    const blocker = parsePostgresForeignKeyViolation(error)
    const blockers = hierarchyDeleteFkBlockersFromViolation(blocker)
    if (blocker?.constraint) {
      compatLogWarn(
        'hierarchy-delete',
        `delete blocked by FK ${blocker.constraint} (${blocker.table})`
      )
    } else if (blocker?.table) {
      compatLogWarn('hierarchy-delete', `delete blocked by FK on ${blocker.table}`)
    }
    return { status: 'has_children', blockers }
  }
}

export function hierarchyDeleteHasChildrenResponse(
  c: Context,
  blockers: readonly HierarchyDeleteFkBlocker[] = []
): Response {
  return c.json(
    {
      error: hierarchyDeleteHasChildrenMessage(),
      code: HIERARCHY_DELETE_HAS_CHILDREN_CODE,
      ...(blockers.length > 0 ? { blockers: [...blockers] } : {}),
    },
    409
  )
}

/** When delete hit a child FK, return the 409 response; otherwise `null`. */
export function hierarchyDeleteHasChildrenResponseIfNeeded(
  c: Context,
  result: HierarchyDeleteRunResult
): Response | null {
  if (result.status !== 'has_children') return null
  return hierarchyDeleteHasChildrenResponse(c, result.blockers)
}

/** Run a hierarchy delete in a transaction and map FK blocks to the standard 409. */
export async function respondAfterHierarchyDelete(
  c: Context,
  db: Db,
  deleteOp: (tx: Db) => Promise<void>
): Promise<Response> {
  const deleteResult = await runHierarchyDelete(db, deleteOp)
  const blocked = hierarchyDeleteHasChildrenResponseIfNeeded(c, deleteResult)
  if (blocked) return blocked
  return c.json({ ok: true as const })
}
