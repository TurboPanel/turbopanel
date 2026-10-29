/**
 * Which hostings belong to an organization. A `hostname` row names its routing
 * organization, but the hosting it points at must really sit in that
 * organization (hosting, service, environment, project), or a name could tie a
 * tunnel to another organization's site.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, hosting, project, service } from '../../db/schema.ts'

/** The subset of `hostingIds` whose project belongs to `organizationId`. */
export async function hostingIdsOfOrganization(
  db: Db,
  hostingIds: readonly string[],
  organizationId: string
): Promise<Set<string>> {
  if (hostingIds.length === 0) return new Set()
  const rows = await db
    .select({ id: hosting.id })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(and(inArray(hosting.id, [...hostingIds]), eq(project.organizationId, organizationId)))
  return new Set(rows.map((r) => r.id))
}
