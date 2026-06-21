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
    case 'realm':
      return sql`
        SELECT 'realm'::text AS entity_type, r.id AS entity_id, 0 AS depth
        FROM realm r WHERE r.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, r.organization_id, 1
        FROM realm r WHERE r.id = ${entityId}::uuid
      `
    case 'environment':
      return sql`
        SELECT 'environment'::text AS entity_type, e.id AS entity_id, 0 AS depth
        FROM environment e WHERE e.id = ${entityId}::uuid
        UNION ALL
        SELECT 'realm'::text, e.realm_id, 1
        FROM environment e WHERE e.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, e.organization_id, 2
        FROM environment e WHERE e.id = ${entityId}::uuid
      `
    case 'project':
      return sql`
        SELECT 'project'::text AS entity_type, p.id AS entity_id, 0 AS depth
        FROM project p WHERE p.id = ${entityId}::uuid
        UNION ALL
        SELECT 'environment'::text, p.environment_id, 1
        FROM project p WHERE p.id = ${entityId}::uuid
        UNION ALL
        SELECT 'realm'::text, e.realm_id, 2
        FROM project p
        JOIN environment e ON e.id = p.environment_id
        WHERE p.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, p.organization_id, 3
        FROM project p WHERE p.id = ${entityId}::uuid
      `
    case 'service':
      return sql`
        SELECT 'service'::text AS entity_type, s.id AS entity_id, 0 AS depth
        FROM service s WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'project'::text, s.project_id, 1
        FROM service s WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'environment'::text, p.environment_id, 2
        FROM service s
        JOIN project p ON p.id = s.project_id
        WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'realm'::text, e.realm_id, 3
        FROM service s
        JOIN project p ON p.id = s.project_id
        JOIN environment e ON e.id = p.environment_id
        WHERE s.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, s.organization_id, 4
        FROM service s WHERE s.id = ${entityId}::uuid
      `
    case 'hosting':
      return sql`
        SELECT 'hosting'::text AS entity_type, h.id AS entity_id, 0 AS depth
        FROM hosting h WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'project'::text, h.project_id, 1
        FROM hosting h WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'environment'::text, p.environment_id, 2
        FROM hosting h
        JOIN project p ON p.id = h.project_id
        WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'realm'::text, e.realm_id, 3
        FROM hosting h
        JOIN project p ON p.id = h.project_id
        JOIN environment e ON e.id = p.environment_id
        WHERE h.id = ${entityId}::uuid
        UNION ALL
        SELECT 'organization'::text, h.organization_id, 4
        FROM hosting h WHERE h.id = ${entityId}::uuid
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

/** Non-recursive walk from all org-scoped leaves upward (bounded depth per kind). */
function buildWalkBody(kind: string, organizationId: string): SQL {
  switch (kind) {
    case 'organization':
      return sql`
        SELECT id AS leaf_id, 'organization'::text AS entity_type, id AS entity_id, 0 AS depth
        FROM organization WHERE id = ${organizationId}::uuid
      `
    case 'workspace':
    case 'realm':
      return sql`
        SELECT r.id AS leaf_id, 'realm'::text AS entity_type, r.id AS entity_id, 0 AS depth
        FROM realm r WHERE r.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT r.id, 'organization'::text, r.organization_id, 1
        FROM realm r WHERE r.organization_id = ${organizationId}::uuid
      `
    case 'environment':
      return sql`
        SELECT e.id AS leaf_id, 'environment'::text AS entity_type, e.id AS entity_id, 0 AS depth
        FROM environment e WHERE e.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT e.id, 'realm'::text, e.realm_id, 1
        FROM environment e WHERE e.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT e.id, 'organization'::text, e.organization_id, 2
        FROM environment e WHERE e.organization_id = ${organizationId}::uuid
      `
    case 'project':
      return sql`
        SELECT p.id AS leaf_id, 'project'::text AS entity_type, p.id AS entity_id, 0 AS depth
        FROM project p WHERE p.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT p.id, 'environment'::text, p.environment_id, 1
        FROM project p WHERE p.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT p.id, 'realm'::text, e.realm_id, 2
        FROM project p
        JOIN environment e ON e.id = p.environment_id
        WHERE p.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT p.id, 'organization'::text, p.organization_id, 3
        FROM project p WHERE p.organization_id = ${organizationId}::uuid
      `
    case 'service':
      return sql`
        SELECT s.id AS leaf_id, 'service'::text AS entity_type, s.id AS entity_id, 0 AS depth
        FROM service s WHERE s.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT s.id, 'project'::text, s.project_id, 1
        FROM service s WHERE s.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT s.id, 'environment'::text, p.environment_id, 2
        FROM service s
        JOIN project p ON p.id = s.project_id
        WHERE s.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT s.id, 'realm'::text, e.realm_id, 3
        FROM service s
        JOIN project p ON p.id = s.project_id
        JOIN environment e ON e.id = p.environment_id
        WHERE s.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT s.id, 'organization'::text, s.organization_id, 4
        FROM service s WHERE s.organization_id = ${organizationId}::uuid
      `
    case 'hosting':
      return sql`
        SELECT h.id AS leaf_id, 'hosting'::text AS entity_type, h.id AS entity_id, 0 AS depth
        FROM hosting h WHERE h.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT h.id, 'project'::text, h.project_id, 1
        FROM hosting h WHERE h.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT h.id, 'environment'::text, p.environment_id, 2
        FROM hosting h
        JOIN project p ON p.id = h.project_id
        WHERE h.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT h.id, 'realm'::text, e.realm_id, 3
        FROM hosting h
        JOIN project p ON p.id = h.project_id
        JOIN environment e ON e.id = p.environment_id
        WHERE h.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT h.id, 'organization'::text, h.organization_id, 4
        FROM hosting h WHERE h.organization_id = ${organizationId}::uuid
      `
    case 'server':
      return sql`
        SELECT s.id AS leaf_id, 'server'::text AS entity_type, s.id AS entity_id, 0 AS depth
        FROM server s WHERE s.organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT s.id, 'organization'::text, s.organization_id, 1
        FROM server s WHERE s.organization_id = ${organizationId}::uuid
      `
    default:
      throw new Error(`Unknown entity kind for visibility walk: ${kind}`)
  }
}

function buildLeavesBody(kind: string, organizationId: string): SQL {
  switch (kind) {
    case 'organization':
      return sql`SELECT id FROM organization WHERE id = ${organizationId}::uuid`
    case 'workspace':
    case 'realm':
      return sql`SELECT id FROM realm WHERE organization_id = ${organizationId}::uuid`
    case 'environment':
      return sql`SELECT id FROM environment WHERE organization_id = ${organizationId}::uuid`
    case 'project':
      return sql`SELECT id FROM project WHERE organization_id = ${organizationId}::uuid`
    case 'service':
      return sql`SELECT id FROM service WHERE organization_id = ${organizationId}::uuid`
    case 'hosting':
      return sql`SELECT id FROM hosting WHERE organization_id = ${organizationId}::uuid`
    case 'server':
      return sql`SELECT id FROM server WHERE organization_id = ${organizationId}::uuid`
    default:
      throw new Error(`Unknown entity kind for visibility leaves: ${kind}`)
  }
}

/**
 * Resolve whether `userId` holds `permissionKey` on the entity (or any of its
 * ancestors) using domain FK joins and `grant` rows.
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

  const rows = (await db.execute(sql`
    WITH
    subjectset(subject_type, subject_id) AS (
      ${subjectsetBody}
    ),
    ancestry(entity_type, entity_id, depth) AS (
      ${ancestryBody}
    ),
    hits AS (
      SELECT ag.allowed, a.depth
      FROM ancestry a
      JOIN ${grant} ag
        ON ag.entity_id = a.entity_id
        AND (
          ag.entity_type = a.entity_type
          OR (
            ag.entity_type IN ('realm', 'workspace')
            AND a.entity_type IN ('realm', 'workspace')
          )
        )
      JOIN subjectset ss
        ON ss.subject_type = ag.subject_type AND ss.subject_id = ag.subject_id
      WHERE ag.permission = ${permissionKey}
      ORDER BY a.depth ASC, (ag.allowed = false) DESC
      LIMIT 1
    )
    SELECT (
      EXISTS(SELECT 1 FROM "user" WHERE id = ${userId}::uuid AND role IN ('superadmin', 'admin'))
      OR coalesce((SELECT allowed FROM hits), false)
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
 * Return entity ids of `kind` within `organizationId` that the user can at
 * least read (`<kind>:ro` or `<kind>:rw`) after leaf-first, deny-beats-allow
 * resolution matching {@link can}.
 */
export async function listVisible(
  db: Db,
  { kind, userId, organizationId }: ListVisibleInput,
): Promise<string[]> {
  const subjectsetBody = buildSubjectsetBody(userId)
  const leavesBody = buildLeavesBody(kind, organizationId)
  const walkBody = buildWalkBody(kind, organizationId)
  const roKey = `${kind}:ro` as PermissionKey
  const rwKey = `${kind}:rw` as PermissionKey

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
    leaves AS (
      ${leavesBody}
    ),
    walk(leaf_id, entity_type, entity_id, depth) AS (
      ${walkBody}
    ),
    hits AS (
      SELECT
        w.leaf_id,
        ag.allowed,
        w.depth,
        ag.permission
      FROM walk w
      JOIN ${grant} ag
        ON ag.entity_id = w.entity_id
        AND (
          ag.entity_type = w.entity_type
          OR (
            ag.entity_type IN ('realm', 'workspace')
            AND w.entity_type IN ('realm', 'workspace')
          )
        )
      JOIN subjectset ss
        ON ss.subject_type = ag.subject_type AND ss.subject_id = ag.subject_id
      WHERE ag.permission IN (${roKey}, ${rwKey})
    ),
    resolved AS (
      SELECT DISTINCT ON (leaf_id, permission)
        leaf_id,
        permission,
        allowed
      FROM hits
      ORDER BY leaf_id, permission, depth ASC, (allowed = false) DESC
    ),
    visible AS (
      SELECT DISTINCT leaf_id
      FROM resolved
      WHERE allowed = true
    )
    SELECT l.id AS item_id
    FROM leaves l
    WHERE (SELECT val FROM is_superadmin)
       OR EXISTS (SELECT 1 FROM visible v WHERE v.leaf_id = l.id)
  `)) as unknown as Array<{ item_id: string }>

  return rows.map((row) => row.item_id)
}
