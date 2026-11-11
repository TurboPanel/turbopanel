/**
 * A cache's variable names must not be set by hand where only they could win:
 * a service- or hostname-scope variable (not binding output) with the same name
 * is refused. Inherited scopes are overridden instead, with a warning.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { hosting, service, variable } from '../../db/schema.ts'

/** Names among `names` that a service- or hostname-scope variable of the environment already sets. */
export async function findCacheKeyConflicts(
  db: Db,
  environmentId: string,
  names: readonly string[]
): Promise<string[]> {
  if (names.length === 0) return []
  const serviceRows = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = serviceRows.map((row) => row.id)
  if (serviceIds.length === 0) return []
  const hostingRows = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(inArray(hosting.serviceId, serviceIds))
  const hostingIds = hostingRows.map((row) => row.id)
  const scope =
    hostingIds.length === 0
      ? inArray(variable.serviceId, serviceIds)
      : or(inArray(variable.serviceId, serviceIds), inArray(variable.hostingId, hostingIds))
  const rows = await db
    .select({ key: variable.key })
    .from(variable)
    .where(and(inArray(variable.key, [...names]), isNull(variable.bindingId), scope))
  return [...new Set(rows.map((row) => row.key))].toSorted((a, b) => a.localeCompare(b))
}
