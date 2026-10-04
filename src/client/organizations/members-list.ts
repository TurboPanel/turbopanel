/**
 * Who is in an organization (`GET /organizations/:id/members`), as the people
 * the app shows on its Members screen.
 *
 * A person is a member through a team in the organization, or through a grant
 * on the organization or on one of its teams (the same footprint the remove
 * route clears). The role is the highest organization grant they hold.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { grant, team, teammate, user } from '../../db/schema.ts'

export type MemberRole = 'owner' | 'manager' | 'member'

export type MemberRow = {
  id: string
  name: string | null
  email: string
  role: MemberRole
  joinedAt: string
}

export type MemberTie = { userId: string; at: string; permission?: string }

const ROLE_RANK: Record<MemberRole, number> = { owner: 2, manager: 1, member: 0 }

function roleOf(permission: string | undefined): MemberRole {
  if (permission === 'organization:own') return 'owner'
  if (permission === 'organization:manage') return 'manager'
  return 'member'
}

/** Fold every team membership and grant into one entry per person: highest role, earliest date. */
export function foldMemberTies(
  ties: MemberTie[]
): Map<string, { role: MemberRole; joinedAt: string }> {
  const folded = new Map<string, { role: MemberRole; joinedAt: string }>()
  for (const tie of ties) {
    const role = roleOf(tie.permission)
    const seen = folded.get(tie.userId)
    if (!seen) {
      folded.set(tie.userId, { role, joinedAt: tie.at })
      continue
    }
    if (ROLE_RANK[role] > ROLE_RANK[seen.role]) seen.role = role
    if (Date.parse(tie.at) < Date.parse(seen.joinedAt)) seen.joinedAt = tie.at
  }
  return folded
}

async function loadTies(db: Db, organizationId: string): Promise<MemberTie[]> {
  const orgTeams = sql`(select ${team.id} from ${team} where ${team.organizationId} = ${organizationId})`
  const [teamRows, grantRows] = await Promise.all([
    db
      .select({ userId: teammate.userId, at: teammate.createdAt })
      .from(teammate)
      .where(inArray(teammate.teamId, orgTeams)),
    db
      .select({ userId: grant.actorId, at: grant.createdAt, permission: grant.permission })
      .from(grant)
      .where(
        and(
          eq(grant.actorType, 'user'),
          or(
            and(eq(grant.entityType, 'organization'), eq(grant.entityId, organizationId)),
            and(eq(grant.entityType, 'team'), inArray(grant.entityId, orgTeams))
          )
        )
      ),
  ])
  return [
    ...teamRows,
    ...grantRows.map((g) => ({
      userId: g.userId,
      at: g.at,
      // A team grant makes someone a member; only grants on the organization itself set the role.
      permission: g.permission.startsWith('organization:') ? g.permission : undefined,
    })),
  ]
}

const byRoleThenName = (a: MemberRow, b: MemberRow): number => {
  const rank = ROLE_RANK[b.role] - ROLE_RANK[a.role]
  if (rank !== 0) return rank
  return (a.name ?? a.email).localeCompare(b.name ?? b.email)
}

export async function listOrganizationMembers(
  db: Db,
  organizationId: string
): Promise<MemberRow[]> {
  const folded = foldMemberTies(await loadTies(db, organizationId))
  const ids = [...folded.keys()]
  if (ids.length === 0) return []
  const people = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, ids))
  return people.map((p) => ({ ...p, ...folded.get(p.id)! })).toSorted(byRoleThenName)
}
