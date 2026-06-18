import { eq, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../db.ts'
import { member, teammate } from '../db/schema.ts'
import type { PermissionKey } from './catalog.ts'

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

export type ResourceAncestryRow = {
  id: string
  parentId: string | null
  depth: number
}

/**
 * Walk from `resourceId` up through `parent_id` to the root. Depth 0 is the
 * leaf; larger depths are farther ancestors.
 */
export async function getResourceAncestry(
  db: Db,
  resourceId: string,
): Promise<ResourceAncestryRow[]> {
  const rows = (await db.execute(sql`
    WITH RECURSIVE ancestry(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM resource WHERE id = ${resourceId}::uuid
      UNION ALL
      SELECT r.id, r.parent_id, a.depth + 1
      FROM resource r
      JOIN ancestry a ON r.id = a.parent_id
    )
    SELECT id, parent_id AS "parentId", depth
    FROM ancestry
    ORDER BY depth ASC
  `)) as unknown as ResourceAncestryRow[]

  return rows
}

/** Build the `subjectset` CTE body, either from a pre-fetched set or inline. */
function buildSubjectsetBody(userId: string, subjects?: Subject[]): SQL {
  if (subjects && subjects.length > 0) {
    const rows = subjects.map(
      (s) => sql`(${s.subjectKind}::subjectkind, ${s.subjectId}::uuid)`,
    )
    const separator = sql.raw(', ')
    const values = sql.join(rows, separator)
    return sql`SELECT * FROM (VALUES ${values}) AS s(subject_kind, subject_id)`
  }

  return sql`
    SELECT 'user'::subjectkind AS subject_kind, ${userId}::uuid AS subject_id
    UNION
    SELECT 'team'::subjectkind, team_id FROM teammate WHERE user_id = ${userId}::uuid
    UNION
    SELECT 'organization'::subjectkind, organization_id FROM member WHERE user_id = ${userId}::uuid
  `
}

/**
 * Resolve whether `userId` holds `permissionKey` on `resourceId` (or any of its
 * ancestors) using a single recursive-CTE round-trip:
 *
 * 1. `subjectset` — the user plus their teams and organizations.
 * 2. `ancestry` — the leaf resource walked up via `parent_id`.
 * 3. `hits` — access grants matching subject + permission (direct or via role
 *    permit), ordered closest-first with deny winning ties.
 */
export async function can(
  db: Db,
  userId: string,
  permissionKey: PermissionKey,
  resourceId: string,
  opts?: CanOptions,
): Promise<boolean> {
  const subjectsetBody = buildSubjectsetBody(userId, opts?.subjects)

  const rows = (await db.execute(sql`
    WITH RECURSIVE
    subjectset(subject_kind, subject_id) AS (
      ${subjectsetBody}
    ),
    ancestry(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM resource WHERE id = ${resourceId}::uuid
      UNION ALL
      SELECT r.id, r.parent_id, a.depth + 1
      FROM resource r
      JOIN ancestry a ON r.id = a.parent_id
    ),
    hits AS (
      SELECT acc.effect AS effect, a.depth AS depth
      FROM ancestry a
      JOIN access acc ON acc.resource_id = a.id
      JOIN subjectset ss
        ON ss.subject_kind = acc.subject_kind AND ss.subject_id = acc.subject_id
      WHERE (
        acc.permission_id = (SELECT id FROM permission WHERE key = ${permissionKey})
        OR acc.role_id IN (
          SELECT pm.role_id
          FROM permit pm
          JOIN permission p ON p.id = pm.permission_id
          WHERE p.key = ${permissionKey}
        )
      )
      ORDER BY a.depth ASC, (acc.effect = 'deny') DESC
      LIMIT 1
    )
    SELECT coalesce((SELECT effect = 'allow' FROM hits), false) AS allowed
  `)) as unknown as Array<{ allowed: boolean | null }>

  return rows[0]?.allowed === true
}

/** {@link can} that throws {@link ForbiddenError} when the check fails. */
export async function assertCan(
  db: Db,
  userId: string,
  permissionKey: PermissionKey,
  resourceId: string,
  opts?: CanOptions,
): Promise<void> {
  const allowed = await can(db, userId, permissionKey, resourceId, opts)
  if (!allowed) {
    throw new ForbiddenError(permissionKey)
  }
}

export type ListVisibleInput = {
  kind: string
  userId: string
  organizationId: string
  /** Optional subtree scoping (e.g. projects within an environment). */
  filters?: { parentId?: string }
}

/**
 * Return the `item_id` values of resources of `kind` within `organizationId`
 * that the user can at least read (`<kind>:ro` or `<kind>:rw`) after the same
 * leaf-first, deny-beats-allow resolution as {@link can}. The visibility
 * predicate stays in SQL — never filter client-side.
 */
export async function listVisible(
  db: Db,
  { kind, userId, organizationId, filters }: ListVisibleInput,
): Promise<string[]> {
  const subjectsetBody = buildSubjectsetBody(userId)
  const roKey = `${kind}:ro`
  const rwKey = `${kind}:rw`
  const parentFilter = filters?.parentId
    ? sql`AND parent_id = ${filters.parentId}::uuid`
    : sql``

  const rows = (await db.execute(sql`
    WITH RECURSIVE
    subjectset(subject_kind, subject_id) AS (
      ${subjectsetBody}
    ),
    leaves AS (
      SELECT id, item_id, parent_id
      FROM resource
      WHERE kind = ${kind} AND organization_id = ${organizationId}::uuid
      ${parentFilter}
    ),
    walk(leaf_item_id, node_id, parent_id, depth) AS (
      SELECT item_id, id, parent_id, 0 FROM leaves
      UNION ALL
      SELECT w.leaf_item_id, r.id, r.parent_id, w.depth + 1
      FROM resource r
      JOIN walk w ON r.id = w.parent_id
    ),
    hits AS (
      SELECT
        w.leaf_item_id,
        p.key AS permission_key,
        acc.effect AS effect,
        w.depth AS depth
      FROM walk w
      JOIN access acc ON acc.resource_id = w.node_id
      JOIN subjectset ss
        ON ss.subject_kind = acc.subject_kind AND ss.subject_id = acc.subject_id
      JOIN LATERAL (
        SELECT perm.key
        FROM permission perm
        WHERE acc.permission_id = perm.id
          AND perm.key IN (${roKey}, ${rwKey})
        UNION
        SELECT perm.key
        FROM permit pm
        JOIN permission perm ON perm.id = pm.permission_id
        WHERE pm.role_id = acc.role_id
          AND perm.key IN (${roKey}, ${rwKey})
      ) p ON true
    ),
    resolved AS (
      SELECT DISTINCT ON (leaf_item_id, permission_key)
        leaf_item_id,
        permission_key,
        effect
      FROM hits
      ORDER BY leaf_item_id, permission_key, depth ASC, (effect = 'deny') DESC
    )
    SELECT DISTINCT l.item_id AS item_id
    FROM leaves l
    WHERE EXISTS (
      SELECT 1
      FROM resolved r
      WHERE r.leaf_item_id = l.item_id
        AND r.effect = 'allow'
    )
  `)) as unknown as Array<{ item_id: string }>

  return rows.map((row) => row.item_id)
}
