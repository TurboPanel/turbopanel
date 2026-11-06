/**
 * Keeps each doorway pointed at the site that holds its name today.
 *
 * A doorway keeps the hostname text; the site link is read once, when the
 * doorway is added. Sites change underneath it: a site is created later with
 * the name, the name moves to another site, or the site is deleted (a hostname
 * edit deletes and re-inserts the site's name rows). The routing facts follow
 * `doorway.hostingId`, so it is re-read from the `hostname` table before tables
 * are built.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { doorway, hostname as hostnameTable } from '../../db/schema.ts'
import { hostingIdsOfOrganization } from './hosting-scope.ts'

/** Re-point the organization's doorways at the sites that hold their names. Returns how many changed. */
export async function relinkDoorwayHostings(db: Db, organizationId: string): Promise<number> {
  const doorways = await db
    .select({ id: doorway.id, hostname: doorway.hostname, hostingId: doorway.hostingId })
    .from(doorway)
    .where(eq(doorway.routingOrganizationId, organizationId))
  if (doorways.length === 0) return 0
  const holders = await db
    .select({ hostname: hostnameTable.hostname, hostingId: hostnameTable.hostingId })
    .from(hostnameTable)
    .where(
      and(
        eq(hostnameTable.routingOrganizationId, organizationId),
        inArray(
          hostnameTable.hostname,
          doorways.map((d) => d.hostname)
        )
      )
    )
  // A site of another organization never counts as the site of a name.
  const own = await hostingIdsOfOrganization(
    db,
    holders.map((h) => h.hostingId),
    organizationId
  )
  const siteOfName = new Map<string, string>()
  for (const h of holders) if (own.has(h.hostingId)) siteOfName.set(h.hostname, h.hostingId)
  const moved = doorways.filter((d) => (siteOfName.get(d.hostname) ?? null) !== d.hostingId)
  await Promise.all(
    moved.map((d) =>
      db
        .update(doorway)
        .set({ hostingId: siteOfName.get(d.hostname) ?? null })
        .where(eq(doorway.id, d.id))
    )
  )
  return moved.length
}
