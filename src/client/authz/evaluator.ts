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

/** Build the `subjectset` CTE body, either from a pre-fetched set or inline. */
function buildSubjectsetBody(userId: string, subjects?: Subject[]): SQL {
  if (subjects && subjects.length > 0) {
    const rows = subjects.map(
      (s) => sql`(${s.subjectKind}::text, ${s.subjectId}::uuid)`,
    )
    const separator = sql.raw(', ')
    const values = sql.join(rows, separator)
    return sql`SELECT * FROM (VALUES ${values}) AS s(subject_type, subject_id)`
  }

  return sql`
    SELECT 'user'::text AS subject_type, ${userId}::uuid AS subject_id
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
        FROM hosting h WHERE h.id = ${entityId}::uuid AND h.service_id IS NOT NULL
        UNION ALL
        SELECT 'environment'::text, s.environment_id, 2
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        WHERE h.id = ${entityId}::uuid AND h.service_id IS NOT NULL
        UNION ALL
        SELECT 'project'::text, e.project_id, 3
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        WHERE h.id = ${entityId}::uuid AND h.service_id IS NOT NULL
        UNION ALL
        SELECT 'workspace'::text, p.workspace_id, 4
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        WHERE h.id = ${entityId}::uuid AND h.service_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, w.organization_id, 5
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE h.id = ${entityId}::uuid AND h.service_id IS NOT NULL
        UNION ALL
        SELECT 'organization'::text, h.organization_id, 1
        FROM hosting h WHERE h.id = ${entityId}::uuid AND h.service_id IS NULL
      `
    case 'server':
      return sql`
        SELECT 'server'::text AS entity_type, s.id AS entity_id, 0 AS depth
        FROM server s WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, s.organization_id, 1
        FROM server s WHERE s.id = ${entityId}::uuid
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
        WHERE w.organization_id = ${organizationId}::uuid
        UNION
        SELECT h.id FROM hosting h
        WHERE h.service_id IS NULL AND h.organization_id = ${organizationId}::uuid`
    case 'server':
      return sql`SELECT id FROM server WHERE organization_id = ${organizationId}::uuid`
    default:
      throw new Error(`Unknown entity kind for visibility leaves: ${kind}`)
  }
}

/**
 * Resolve whether `userId` holds the requested permission on the entity.
 * Org-level `organization:own` / `organization:manage` grants on the owning
 * organization apply to all entities in that org. For team-scoped checks on a
 * team entity, direct `team:own` / `team:manage` grants on the team are also
 * honored.
 */
export async function can(
  db: Db,
  userId: string,
  permissionKey: PermissionKey,
  entityType: string,
  entityId: string,
  opts?: CanOptions,
): Promise<boolean> {
  const subjectsetBody = buildSubjectsetBody(userId, opts?.subjects)
  const ancestryBody = buildAncestryBody(entityType, entityId)

  const isTeamScopedCheck =
    entityType === 'team' &&
    (permissionKey === 'team:own' || permissionKey === 'team:manage')

  const teamPermissionFilter = isTeamScopedCheck
    ? permissionKey === 'team:own'
      ? sql`ag.permission = 'team:own'`
      : sql`ag.permission IN ('team:own', 'team:manage')`
    : sql`false`

  const rows = (await db.execute(sql`
    WITH
    subjectset(subject_type, subject_id) AS (
      ${subjectsetBody}
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
      JOIN subjectset ss
        ON ss.subject_type = ag.subject_type AND ss.subject_id = ag.subject_id
      WHERE ag.entity_type = 'organization'
        AND ag.entity_id = (SELECT entity_id FROM org_id)
        AND ag.permission IN ('organization:own', 'organization:manage')
        AND ag.allow = true
      LIMIT 1
    ),
    team_hits AS (
      SELECT ag.allow
      FROM ${grant} ag
      JOIN subjectset ss
        ON ss.subject_type = ag.subject_type AND ss.subject_id = ag.subject_id
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
  const subjectsetBody = buildSubjectsetBody(userId)
  const leavesBody = buildLeavesBody(kind, organizationId)

  const rows = (await db.execute(sql`
    WITH
    subjectset(subject_type, subject_id) AS (
      ${subjectsetBody}
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
        JOIN subjectset ss
          ON ss.subject_type = ag.subject_type AND ss.subject_id = ag.subject_id
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
