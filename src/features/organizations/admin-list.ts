/**
 * The platform admin's list of organizations (`GET /api/admin/v1/organizations`).
 *
 * One statement: the organization rows joined to grouped counts (members,
 * servers, projects) and to the owner, so the cost does not grow with the
 * number of organizations. A person is a member through a team in the
 * organization or through a grant on it or on one of its teams, the same
 * footprint as `client/organizations/members-list.ts`. The owner is the
 * person who has held an `organization:own` grant longest.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { grant, organization, project, server, team, teammate, user } from '../../db/schema.ts'

export type AdminOrganizationRow = {
  id: string
  name: string | null
  createdAt: string
  owner: { id: string; name: string | null; email: string } | null
  memberCount: number
  serverCount: number
  projectCount: number
  /** True for the organization the install created for its platform admin. */
  isRoot: boolean
}

/** Every organization, oldest first. `rootOrganizationId` marks the root one. */
export async function listOrganizationsForAdmin(
  db: Db,
  rootOrganizationId: string | null
): Promise<AdminOrganizationRow[]> {
  const owners = db
    .selectDistinctOn([grant.entityId], {
      organizationId: grant.entityId,
      userId: grant.actorId,
    })
    .from(grant)
    .where(
      sql`${grant.entityType} = 'organization' and ${grant.actorType} = 'user' and ${grant.permission} = 'organization:own'`
    )
    .orderBy(grant.entityId, grant.createdAt, grant.id)
    .as('owners')

  const memberCounts = db
    .select({
      organizationId: sql<string>`m.organization_id`.as('organization_id'),
      memberTotal: sql<number>`count(distinct m.user_id)::int`.as('member_total'),
    })
    .from(
      sql`(
        select ${team.organizationId} as organization_id, ${teammate.userId} as user_id
          from ${teammate} join ${team} on ${team.id} = ${teammate.teamId}
        union
        select ${grant.entityId}, ${grant.actorId} from ${grant}
          where ${grant.entityType} = 'organization' and ${grant.actorType} = 'user'
        union
        select ${team.organizationId}, ${grant.actorId}
          from ${grant} join ${team} on ${team.id} = ${grant.entityId}
          where ${grant.entityType} = 'team' and ${grant.actorType} = 'user'
      ) as m`
    )
    .groupBy(sql`m.organization_id`)
    .as('member_counts')

  const serverCounts = db
    .select({
      organizationId: server.organizationId,
      serverTotal: sql<number>`count(*)::int`.as('server_total'),
    })
    .from(server)
    .groupBy(server.organizationId)
    .as('server_counts')

  const projectCounts = db
    .select({
      organizationId: project.organizationId,
      projectTotal: sql<number>`count(*)::int`.as('project_total'),
    })
    .from(project)
    .groupBy(project.organizationId)
    .as('project_counts')

  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt,
      ownerId: user.id,
      ownerName: user.name,
      ownerEmail: user.email,
      memberCount: memberCounts.memberTotal,
      serverCount: serverCounts.serverTotal,
      projectCount: projectCounts.projectTotal,
    })
    .from(organization)
    .leftJoin(owners, eq(owners.organizationId, organization.id))
    .leftJoin(user, eq(user.id, owners.userId))
    .leftJoin(memberCounts, eq(memberCounts.organizationId, organization.id))
    .leftJoin(serverCounts, eq(serverCounts.organizationId, organization.id))
    .leftJoin(projectCounts, eq(projectCounts.organizationId, organization.id))
    .orderBy(organization.createdAt, organization.id)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    owner:
      row.ownerId === null || row.ownerEmail === null
        ? null
        : { id: row.ownerId, name: row.ownerName, email: row.ownerEmail },
    memberCount: row.memberCount ?? 0,
    serverCount: row.serverCount ?? 0,
    projectCount: row.projectCount ?? 0,
    isRoot: row.id === rootOrganizationId,
  }))
}
