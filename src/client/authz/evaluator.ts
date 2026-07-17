import { eq, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { grant, member, teammate } from '../../lib/db/schema.ts'
import { type PermissionKey } from './catalog.ts'

export type { PermissionKey }

export type SubjectKind = 'user' | 'team' | 'organization'

export type Subject = {
  subjectKind: SubjectKind
  subjectId: string
}

/** Thrown by {@link assertCan} when a permission check fails. */
export class ForbiddenError extends Error {
  readonly permissionKey: string

  constructor(permissionKey: string) {
    super(`Forbidden: ${permissionKey}`)
    this.name = 'ForbiddenError'
    this.permissionKey = permissionKey
  }
}

export type CanOptions = {
  /**
   * Pre-fetched subject set (request-scope memoization). When omitted, the
   * subject set is resolved inline in SQL from `member` / `teammate`.
   */
  subjects?: Subject[]
}

/**
 * Resolve the full subject set for a user: the user itself, every team they
 * belong to, and every organization they are a member of.
 */
export async function getSubjects(db: Db, userId: string): Promise<Subject[]> {
  const subjects: Subject[] = [{ subjectKind: 'user', subjectId: userId }]

  const teamRows = await db
    .select({ teamId: teammate.teamId })
    .from(teammate)
    .where(eq(teammate.userId, userId))
  for (const row of teamRows) {
    subjects.push({ subjectKind: 'team', subjectId: row.teamId })
  }

  const orgRows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
  for (const row of orgRows) {
    subjects.push({ subjectKind: 'organization', subjectId: row.organizationId })
  }

  return subjects
}

/** Build the `actorset` CTE body, either from a pre-fetched set or inline. */
function buildActorsetBody(userId: string, subjects?: Subject[]): SQL {
  if (subjects && subjects.length > 0) {
    const rows = subjects.map(
      (s) => sql`(${s.subjectKind}::text, ${s.subjectId}::uuid)`,
    )
    const separator = sql.raw(', ')
    const values = sql.join(rows, separator)
    return sql`SELECT * FROM (VALUES ${values}) AS s(actor_type, actor_id)`
  }

  return sql`
    SELECT 'user'::text AS actor_type, ${userId}::uuid AS actor_id
    UNION
    SELECT 'team'::text, team_id FROM teammate WHERE user_id = ${userId}::uuid
    UNION
    SELECT 'organization'::text, organization_id FROM member WHERE user_id = ${userId}::uuid
  `
}

/** Non-recursive ancestry enumeration for a single entity leaf. */
function buildAncestryBody(entityType: string, entityId: string): SQL {
  switch (entityType) {
    case 'organization':
      return sql`
        SELECT 'organization'::text AS entity_type, ${entityId}::uuid AS entity_id, 0 AS depth
      `
    case 'team':
      return sql`
        SELECT 'team'::text AS entity_type, t.id AS entity_id, 0 AS depth
        FROM team t WHERE t.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, t.organization_id, 1
        FROM team t WHERE t.id = ${entityId}::uuid
      `
    case 'workspace':
      return sql`
        SELECT 'workspace'::text AS entity_type, r.id AS entity_id, 0 AS depth
        FROM workspace r WHERE r.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, r.organization_id, 1
        FROM workspace r WHERE r.id = ${entityId}::uuid
      `
    case 'environment':
      return sql`
        SELECT 'environment'::text AS entity_type, e.id AS entity_id, 0 AS depth
        FROM environment e WHERE e.id = ${entityId}::uuid
        UNION ALL
        SELECT 'project'::text, e.project_id, 1
        FROM environment e WHERE e.id = ${entityId}::uuid
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 2
        FROM environment e
        JOIN project p ON p.id = e.project_id
        WHERE e.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 3
        FROM environment e
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE e.id = ${entityId}::uuid
      `
    case 'project':
      return sql`
        SELECT 'project'::text AS entity_type, p.id AS entity_id, 0 AS depth
        FROM project p WHERE p.id = ${entityId}::uuid
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 1
        FROM project p WHERE p.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 2
        FROM project p
        JOIN workspace w ON w.id = p.workspace_id
        WHERE p.id = ${entityId}::uuid
      `
    case 'service':
      return sql`
        SELECT 'service'::text AS entity_type, s.id AS entity_id, 0 AS depth
        FROM service s WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'environment'::text, s.environment_id, 1
        FROM service s WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'project'::text, e.project_id, 2
        FROM service s
        JOIN environment e ON e.id = s.environment_id
        WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 3
        FROM service s
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 4
        FROM service s
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE s.id = ${entityId}::uuid
      `
    case 'hosting':
      return sql`
        SELECT 'hosting'::text AS entity_type, h.id AS entity_id, 0 AS depth
        FROM hosting h WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'service'::text, h.service_id, 1
        FROM hosting h WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'environment'::text, s.environment_id, 2
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'project'::text, e.project_id, 3
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 4
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 5
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE h.id = ${entityId}::uuid
      `
    case 'container':
      return sql`
        SELECT 'container'::text AS entity_type, c.id AS entity_id, 0 AS depth
        FROM container c WHERE c.id = ${entityId}::uuid
        UNION ALL
        SELECT 'service'::text, c.service_id, 1
        FROM container c WHERE c.id = ${entityId}::uuid
        UNION ALL
        SELECT 'environment'::text, s.environment_id, 2
        FROM container c
        JOIN service s ON s.id = c.service_id
        WHERE c.id = ${entityId}::uuid
        UNION ALL
        SELECT 'project'::text, e.project_id, 3
        FROM container c
        JOIN service s ON s.id = c.service_id
        JOIN environment e ON e.id = s.environment_id
        WHERE c.id = ${entityId}::uuid
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 4
        FROM container c
        JOIN service s ON s.id = c.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        WHERE c.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 5
        FROM container c
        JOIN service s ON s.id = c.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE c.id = ${entityId}::uuid
      `
    case 'principal':
      // Org-level grants are sufficient for can(); only emit the organization
      // ancestor (via assignment → service → … → workspace).
      return sql`
        SELECT 'principal'::text AS entity_type, p.id AS entity_id, 0 AS depth
        FROM principal p WHERE p.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 1
        FROM principal p
        JOIN assignment a ON a.principal_id = p.id
        JOIN service s ON s.id = a.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project pr ON pr.id = e.project_id
        JOIN workspace w ON w.id = pr.workspace_id
        WHERE p.id = ${entityId}::uuid
      `
    case 'server':
      return sql`
        SELECT 'server'::text AS entity_type, s.id AS entity_id, 0 AS depth
        FROM server s WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, s.organization_id, 1
        FROM server s WHERE s.id = ${entityId}::uuid
      `
    case 'tls':
      return sql`
        SELECT 'tls'::text AS entity_type, t.id AS entity_id, 0 AS depth
        FROM tls t WHERE t.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, t.organization_id, 1
        FROM tls t WHERE t.id = ${entityId}::uuid
      `
    case 'managed':
      return sql`
        SELECT 'managed'::text AS entity_type, m.id AS entity_id, 0 AS depth
        FROM managed m WHERE m.id = ${entityId}::uuid
        UNION ALL
        SELECT 'project'::text, m.project_id, 1
        FROM managed m WHERE m.id = ${entityId}::uuid
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 2
        FROM managed m
        JOIN project p ON p.id = m.project_id
        WHERE m.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 3
        FROM managed m
        JOIN project p ON p.id = m.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE m.id = ${entityId}::uuid
      `
    case 'variable':
      return sql`
        SELECT 'variable'::text AS entity_type, v.id AS entity_id, 0 AS depth
        FROM variable v WHERE v.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, v.organization_id, 1
        FROM variable v
        WHERE v.id = ${entityId}::uuid AND v.organization_id IS NOT NULL
        UNION ALL
        SELECT 'workspace'::text, v.workspace_id, 1
        FROM variable v
        WHERE v.id = ${entityId}::uuid AND v.workspace_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 2
        FROM variable v
        JOIN workspace w ON w.id = v.workspace_id
        WHERE v.id = ${entityId}::uuid AND v.workspace_id IS NOT NULL
        UNION ALL
        SELECT 'project'::text, v.project_id, 1
        FROM variable v
        WHERE v.id = ${entityId}::uuid AND v.project_id IS NOT NULL
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 2
        FROM variable v
        JOIN project p ON p.id = v.project_id
        WHERE v.id = ${entityId}::uuid AND v.project_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 3
        FROM variable v
        JOIN project p ON p.id = v.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE v.id = ${entityId}::uuid AND v.project_id IS NOT NULL
        UNION ALL
        SELECT 'environment'::text, v.environment_id, 1
        FROM variable v
        WHERE v.id = ${entityId}::uuid AND v.environment_id IS NOT NULL
        UNION ALL
        SELECT 'project'::text, e.project_id, 2
        FROM variable v
        JOIN environment e ON e.id = v.environment_id
        WHERE v.id = ${entityId}::uuid AND v.environment_id IS NOT NULL
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 3
        FROM variable v
        JOIN environment e ON e.id = v.environment_id
        JOIN project p ON p.id = e.project_id
        WHERE v.id = ${entityId}::uuid AND v.environment_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 4
        FROM variable v
        JOIN environment e ON e.id = v.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE v.id = ${entityId}::uuid AND v.environment_id IS NOT NULL
        UNION ALL
        SELECT 'service'::text, v.service_id, 1
        FROM variable v
        WHERE v.id = ${entityId}::uuid AND v.service_id IS NOT NULL
        UNION ALL
        SELECT 'environment'::text, s.environment_id, 2
        FROM variable v
        JOIN service s ON s.id = v.service_id
        WHERE v.id = ${entityId}::uuid AND v.service_id IS NOT NULL
        UNION ALL
        SELECT 'project'::text, e.project_id, 3
        FROM variable v
        JOIN service s ON s.id = v.service_id
        JOIN environment e ON e.id = s.environment_id
        WHERE v.id = ${entityId}::uuid AND v.service_id IS NOT NULL
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 4
        FROM variable v
        JOIN service s ON s.id = v.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        WHERE v.id = ${entityId}::uuid AND v.service_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 5
        FROM variable v
        JOIN service s ON s.id = v.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE v.id = ${entityId}::uuid AND v.service_id IS NOT NULL
        UNION ALL
        SELECT 'hosting'::text, v.hosting_id, 1
        FROM variable v
        WHERE v.id = ${entityId}::uuid AND v.hosting_id IS NOT NULL
        UNION ALL
        SELECT 'service'::text, h.service_id, 2
        FROM variable v
        JOIN hosting h ON h.id = v.hosting_id
        WHERE v.id = ${entityId}::uuid AND v.hosting_id IS NOT NULL
        UNION ALL
        SELECT 'environment'::text, s.environment_id, 3
        FROM variable v
        JOIN hosting h ON h.id = v.hosting_id
        JOIN service s ON s.id = h.service_id
        WHERE v.id = ${entityId}::uuid AND v.hosting_id IS NOT NULL
        UNION ALL
        SELECT 'project'::text, e.project_id, 4
        FROM variable v
        JOIN hosting h ON h.id = v.hosting_id
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        WHERE v.id = ${entityId}::uuid AND v.hosting_id IS NOT NULL
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 5
        FROM variable v
        JOIN hosting h ON h.id = v.hosting_id
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        WHERE v.id = ${entityId}::uuid AND v.hosting_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 6
        FROM variable v
        JOIN hosting h ON h.id = v.hosting_id
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE v.id = ${entityId}::uuid AND v.hosting_id IS NOT NULL
        UNION ALL
        SELECT 'server'::text, v.server_id, 1
        FROM variable v
        WHERE v.id = ${entityId}::uuid AND v.server_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, sv.organization_id, 2
        FROM variable v
        JOIN server sv ON sv.id = v.server_id
        WHERE v.id = ${entityId}::uuid AND v.server_id IS NOT NULL
      `
    default:
      throw new Error(`Unknown entity type for ancestry: ${entityType}`)
  }
}

function buildLeavesBody(kind: string, organizationId: string): SQL {
  switch (kind) {
    case 'organization':
      return sql`SELECT id FROM organization WHERE id = ${organizationId}::uuid`
    case 'workspace':
      return sql`SELECT id FROM workspace WHERE organization_id = ${organizationId}::uuid`
    case 'environment':
      return sql`SELECT e.id FROM environment e
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid`
    case 'project':
      return sql`SELECT p.id FROM project p
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid`
    case 'service':
      return sql`SELECT s.id FROM service s
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid`
    case 'hosting':
      return sql`SELECT h.id FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid`
    case 'container':
      return sql`SELECT c.id FROM container c
        JOIN service s ON s.id = c.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid`
    case 'principal':
      return sql`SELECT DISTINCT p.id FROM principal p
        JOIN assignment a ON a.principal_id = p.id
        JOIN service s ON s.id = a.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project pr ON pr.id = e.project_id
        JOIN workspace w ON w.id = pr.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid`
    case 'server':
      return sql`SELECT id FROM server WHERE organization_id = ${organizationId}::uuid`
    case 'tls':
      return sql`SELECT id FROM tls WHERE organization_id = ${organizationId}::uuid`
    case 'variable':
      return sql`SELECT v.id FROM variable v
        WHERE v.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT v.id FROM variable v
        JOIN workspace w ON w.id = v.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT v.id FROM variable v
        JOIN project p ON p.id = v.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT v.id FROM variable v
        JOIN environment e ON e.id = v.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT v.id FROM variable v
        JOIN service s ON s.id = v.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT v.id FROM variable v
        JOIN hosting h ON h.id = v.hosting_id
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE w.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT v.id FROM variable v
        JOIN server sv ON sv.id = v.server_id
        WHERE sv.organization_id = ${organizationId}::uuid`
    default:
      throw new Error(`Unknown entity kind for visibility leaves: ${kind}`)
  }
}

/**
 * Resolve whether `userId` holds the requested permission on the entity.
 *
 * Organization permission evaluation respects the requested permission:
 * `organization:own` requires an owner grant (`organization:own`), while
 * `organization:manage` accepts either an owner or a manager grant
 * (`organization:own` / `organization:manage`). Org-level grants on the owning
 * organization apply to all entities in that org. For team-scoped checks on a
 * team entity, direct `team:own` / `team:manage` grants on the team are also
 * honored (`team:own` requires an owner grant; `team:manage` accepts either).
 */
export async function can(
  db: Db,
  userId: string,
  permissionKey: PermissionKey,
  entityType: string,
  entityId: string,
  opts?: CanOptions,
): Promise<boolean> {
  const actorsetBody = buildActorsetBody(userId, opts?.subjects)
  const ancestryBody = buildAncestryBody(entityType, entityId)

  // Respect the requested organization permission: an `organization:own` check
  // must require an owner grant, while `organization:manage` accepts owner or
  // manager grants. Team-scoped requests keep the prior org-delegation
  // behavior (an org owner/manager may act on any team in the org).
  const orgPermissionFilter =
    permissionKey === 'organization:own'
      ? sql`ag.permission = 'organization:own'`
      : sql`ag.permission IN ('organization:own', 'organization:manage')`

  const isTeamScopedCheck =
    entityType === 'team' &&
    (permissionKey === 'team:own' || permissionKey === 'team:manage')

  let teamPermissionFilter = sql`false`
  if (isTeamScopedCheck) {
    teamPermissionFilter =
      permissionKey === 'team:own'
        ? sql`ag.permission = 'team:own'`
        : sql`ag.permission IN ('team:own', 'team:manage')`
  }

  const rows = (await db.execute(sql`
    WITH
    actorset(actor_type, actor_id) AS (
      ${actorsetBody}
    ),
    ancestry(entity_type, entity_id, depth) AS (
      ${ancestryBody}
    ),
    org_id AS (
      SELECT entity_id FROM ancestry WHERE entity_type = 'organization' LIMIT 1
    ),
    org_hits AS (
      SELECT ag.allow
      FROM ${grant} ag
      JOIN actorset ss
        ON ss.actor_type = ag.actor_type AND ss.actor_id = ag.actor_id
      WHERE ag.entity_type = 'organization'
        AND ag.entity_id = (SELECT entity_id FROM org_id)
        AND ${orgPermissionFilter}
        AND ag.allow = true
      LIMIT 1
    ),
    team_hits AS (
      SELECT ag.allow
      FROM ${grant} ag
      JOIN actorset ss
        ON ss.actor_type = ag.actor_type AND ss.actor_id = ag.actor_id
      WHERE ${isTeamScopedCheck ? sql`ag.entity_type = 'team'` : sql`false`}
        AND ${isTeamScopedCheck ? sql`ag.entity_id = ${entityId}::uuid` : sql`false`}
        AND ${teamPermissionFilter}
        AND ag.allow = true
      LIMIT 1
    )
    SELECT (
      EXISTS(SELECT 1 FROM "user" WHERE id = ${userId}::uuid AND role IN ('superadmin', 'admin'))
      OR EXISTS(SELECT 1 FROM org_hits)
      OR EXISTS(SELECT 1 FROM team_hits)
    ) AS allowed
  `)) as unknown as Array<{ allowed: boolean | null }>

  return rows[0]?.allowed === true
}

/** {@link can} that throws {@link ForbiddenError} when the check fails. */
export async function assertCan(
  db: Db,
  userId: string,
  permissionKey: PermissionKey,
  entityType: string,
  entityId: string,
  opts?: CanOptions,
): Promise<void> {
  const allowed = await can(db, userId, permissionKey, entityType, entityId, opts)
  if (!allowed) {
    throw new ForbiddenError(permissionKey)
  }
}

export type ListVisibleInput = {
  kind: string
  userId: string
  organizationId: string
}

/**
 * Return entity ids of `kind` within `organizationId` visible to the user.
 * Org owners/managers and platform admins see all leaves; others see none.
 */
export async function listVisible(
  db: Db,
  { kind, userId, organizationId }: ListVisibleInput,
): Promise<string[]> {
  const actorsetBody = buildActorsetBody(userId)
  const leavesBody = buildLeavesBody(kind, organizationId)

  const rows = (await db.execute(sql`
    WITH
    actorset(actor_type, actor_id) AS (
      ${actorsetBody}
    ),
    is_superadmin AS (
      SELECT EXISTS(
        SELECT 1 FROM "user" WHERE id = ${userId}::uuid AND role IN ('superadmin', 'admin')
      ) AS val
    ),
    has_org_access AS (
      SELECT EXISTS(
        SELECT 1
        FROM ${grant} ag
        JOIN actorset ss
          ON ss.actor_type = ag.actor_type AND ss.actor_id = ag.actor_id
        WHERE ag.entity_type = 'organization'
          AND ag.entity_id = ${organizationId}::uuid
          AND ag.permission IN ('organization:own', 'organization:manage')
          AND ag.allow = true
      ) AS val
    ),
    leaves AS (
      ${leavesBody}
    )
    SELECT l.id AS item_id
    FROM leaves l
    WHERE (SELECT val FROM is_superadmin) OR (SELECT val FROM has_org_access)
  `)) as unknown as Array<{ item_id: string }>

  return rows.map((row) => row.item_id)
}
