import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { assignment, environment, service } from '../../lib/db/schema.ts'
import { isUuid } from './store.ts'

/** Service ids linked to each principal (empty array when none). */
export async function loadServiceIdsByPrincipalIds(
  db: Db,
  principalIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  for (const id of principalIds) {
    map.set(id, [])
  }
  if (principalIds.length === 0) return map

  const rows = await db
    .select({
      principalId: assignment.principalId,
      serviceId: assignment.serviceId,
    })
    .from(assignment)
    .where(inArray(assignment.principalId, [...principalIds]))

  for (const row of rows) {
    const list = map.get(row.principalId) ?? []
    list.push(row.serviceId)
    map.set(row.principalId, list)
  }
  for (const [id, list] of map) {
    list.sort((a, b) => a.localeCompare(b))
    map.set(id, list)
  }
  return map
}

/**
 * True when every id is a service in an environment owned by `projectId`.
 * Empty list is valid.
 */
export async function servicesBelongToProject(
  db: Db,
  projectId: string,
  serviceIds: readonly string[],
): Promise<boolean> {
  if (serviceIds.length === 0) return true
  const unique = [...new Set(serviceIds)]
  if (unique.some((id) => !isUuid(id))) return false

  const rows = await db
    .select({ id: service.id })
    .from(service)
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .where(
      and(
        eq(environment.projectId, projectId),
        inArray(service.id, unique),
      ),
    )

  return rows.length === unique.length
}

/** Distinct principal ids assigned to any service in the environment. */
export async function loadPrincipalIdsAssignedToEnvironment(
  db: Db,
  environmentId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ principalId: assignment.principalId })
    .from(assignment)
    .innerJoin(service, eq(assignment.serviceId, service.id))
    .where(eq(service.environmentId, environmentId))

  return rows
    .map((row) => row.principalId)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Principal ids assigned to each service in the environment
 * (empty array when none). Keys are service ids.
 */
export async function loadPrincipalIdsByServiceIdForEnvironment(
  db: Db,
  environmentId: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      principalId: assignment.principalId,
      serviceId: assignment.serviceId,
    })
    .from(assignment)
    .innerJoin(service, eq(assignment.serviceId, service.id))
    .where(eq(service.environmentId, environmentId))

  const map = new Map<string, string[]>()
  for (const row of rows) {
    const list = map.get(row.serviceId) ?? []
    list.push(row.principalId)
    map.set(row.serviceId, list)
  }
  for (const [serviceId, list] of map) {
    list.sort((a, b) => a.localeCompare(b))
    map.set(serviceId, list)
  }
  return map
}

/** Result of picking at most one principal for a traditional-web ownership pin. */
export type SolePrincipalPick =
  | { status: 'none' }
  | { status: 'one'; principalId: string }
  | { status: 'ambiguous' }

/**
 * Pick the single principal for a traditional-web service ownership pin.
 * Zero → `{ status: 'none' }`; one → that principal; more than one → ambiguous.
 */
export function pickSolePrincipalId(
  principalIds: readonly string[],
): SolePrincipalPick {
  if (principalIds.length === 0) return { status: 'none' }
  const [sole] = principalIds
  if (principalIds.length === 1 && sole !== undefined) {
    return { status: 'one', principalId: sole }
  }
  return { status: 'ambiguous' }
}

export function parseServiceIdsField(body: Record<string, unknown>): string[] | null {
  if (!('serviceIds' in body)) return []
  const raw = body.serviceIds
  if (!Array.isArray(raw)) return null
  const ids: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isUuid(entry.trim())) return null
    ids.push(entry.trim())
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}
