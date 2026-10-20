/**
 * Which hostnames of a deploy the host may take over from a leftover host
 * config of another environment.
 *
 * Deleting a hosting does nothing on the host: the environment's config keeps
 * serving the name until that environment is deployed again, and the host
 * refuses another environment's deploy of the same name. A name is listed only
 * when no other live hosting on the server holds it: no other hosting row, in
 * any organization and any environment, that is on this server. The uniqueness
 * constraint on hostnames is per organization, so another organization may hold
 * the same name on a shared server; such a name is never listed and the host
 * refuses, as it always did.
 */
import { and, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { deployment, environment, hosting, hostname, service } from '../../db/schema.ts'

/** What the host accepts in `takeoverHostnames`. */
const TAKEOVER_NAME_RE = /^[a-z0-9*][a-z0-9.*-]*$/

export async function takeoverHostnamesFor(
  db: Pick<Db, 'select'>,
  params: {
    environmentId: string
    serverId: string
    /** The hostings this server's deploy sends. */
    hostingIds: readonly string[]
  }
): Promise<string[]> {
  if (params.hostingIds.length === 0) return []
  const ownRows = await db
    .select({ name: hostname.hostname })
    .from(hostname)
    .where(inArray(hostname.hostingId, [...params.hostingIds]))
  const own = [...new Set(ownRows.map((row) => row.name.toLowerCase()))].filter(
    (name) => name.length <= 253 && TAKEOVER_NAME_RE.test(name)
  )
  if (own.length === 0) return []

  // Any other hosting row with one of these names whose environment is on this
  // server (it has been deployed here, or is pinned here) still holds it.
  const holders = await db
    .select({ name: hostname.hostname })
    .from(hostname)
    .innerJoin(hosting, eq(hostname.hostingId, hosting.id))
    .innerJoin(service, eq(hosting.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .leftJoin(
      deployment,
      and(eq(deployment.environmentId, environment.id), eq(deployment.serverId, params.serverId))
    )
    .where(
      and(
        inArray(sql<string>`lower(${hostname.hostname})`, own),
        notInArray(hostname.hostingId, [...params.hostingIds]),
        or(isNotNull(deployment.id), eq(environment.serverId, params.serverId))
      )
    )
  const held = new Set(holders.map((row) => row.name.toLowerCase()))
  return own.filter((name) => !held.has(name)).sort((a, b) => a.localeCompare(b))
}
