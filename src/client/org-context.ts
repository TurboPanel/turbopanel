import { and, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { getDb } from '../db.ts'
import type { Db } from '../db.ts'
import { grant, organization, team, teammate, user } from '../lib/db/schema.ts'
import { isAdminRole } from './authn/session-store.ts'
import { can } from './authz/index.ts'

/** Request header carrying the active organization for org-scoped client API calls. */
export const ORG_ID_HEADER = 'X-Turbopanel-Organization-Id'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type OrganizationSummary = {
  id: string
  displayName: string | null
  createdAt: string
}

export function parseOrgIdFromRequest(c: Context): string | Response {
  const fromHeader = c.req.header(ORG_ID_HEADER)?.trim()
  const fromQuery = c.req.query('organizationId')?.trim()
  const organizationId = fromHeader || fromQuery

  if (!organizationId) {
    return c.json({ error: 'organizationId required' }, 400)
  }
  if (!UUID_RE.test(organizationId)) {
    return c.json({ error: 'Invalid organizationId' }, 400)
  }
  return organizationId
}

export async function canAccessOrganization(
  db: Db,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const userRows = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)

  if (isAdminRole(userRows[0]?.role)) {
    return true
  }

  const teamRows = await db
    .select({ id: teammate.id })
    .from(teammate)
    .innerJoin(team, eq(teammate.teamId, team.id))
    .where(
      and(
        eq(teammate.userId, userId),
        eq(team.organizationId, organizationId),
      ),
    )
    .limit(1)

  if (teamRows.length > 0) {
    return true
  }

  if (await can(db, userId, 'organization:own', 'organization', organizationId)) {
    return true
  }

  return await can(db, userId, 'organization:manage', 'organization', organizationId)
}

export async function resolveOrgId(
  c: Context,
  userId: string,
): Promise<string | Response> {
  const db = getDb(c)
  if (!db) {
    return c.json({ error: 'Database unavailable' }, 503)
  }

  const parsed = parseOrgIdFromRequest(c)
  if (parsed instanceof Response) {
    return parsed
  }

  const allowed = await canAccessOrganization(db, userId, parsed)
  if (!allowed) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  return parsed
}

export async function listAccessibleOrganizations(
  db: Db,
  userId: string,
): Promise<OrganizationSummary[]> {
  const userRows = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)

  if (isAdminRole(userRows[0]?.role)) {
    return db
      .select({
        id: organization.id,
        displayName: organization.name,
        createdAt: organization.createdAt,
      })
      .from(organization)
      .orderBy(organization.createdAt)
  }

  const rows = (await db.execute(sql`
    WITH
    actorset(actor_type, actor_id) AS (
      SELECT 'user'::text AS actor_type, ${userId}::uuid AS actor_id
      UNION
      SELECT 'team'::text, team_id FROM teammate WHERE user_id = ${userId}::uuid
      UNION
      SELECT 'organization'::text, t.organization_id
      FROM teammate tm
      JOIN team t ON t.id = tm.team_id
      WHERE tm.user_id = ${userId}::uuid
    ),
    grant_orgs AS (
      SELECT DISTINCT ag.entity_id AS organization_id
      FROM ${grant} ag
      JOIN actorset ss
        ON ss.actor_type = ag.actor_type AND ss.actor_id = ag.actor_id
      WHERE ag.entity_type = 'organization'
        AND ag.permission IN ('organization:own', 'organization:manage')
    ),
    member_orgs AS (
      SELECT t.organization_id
      FROM teammate tm
      JOIN team t ON t.id = tm.team_id
      WHERE tm.user_id = ${userId}::uuid
    ),
    accessible_org_ids AS (
      SELECT organization_id FROM grant_orgs
      UNION
      SELECT organization_id FROM member_orgs
    )
    SELECT
      o.id AS id,
      o.name AS "displayName",
      o.created_at AS "createdAt"
    FROM ${organization} o
    WHERE o.id IN (SELECT organization_id FROM accessible_org_ids)
    ORDER BY o.created_at
  `)) as unknown as OrganizationSummary[]

  return rows
}
