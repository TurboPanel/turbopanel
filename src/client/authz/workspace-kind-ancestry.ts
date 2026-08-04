/**
 * Resolve `workspace.kind` for a resource-tree entity by ancestry join.
 *
 * Single ancestry resolver used by {@link assertNotSystemOwnedOr403} — do not
 * re-derive these joins in route handlers.
 */

import { eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { workspace } from '../../lib/db/schema.ts'
import {
  parseWorkspaceKind,
  type WorkspaceKind,
} from '../../lib/db/workspace-kind.ts'

function kindFromRow(value: string | null | undefined): WorkspaceKind | null {
  if (value == null) return null
  return parseWorkspaceKind(value)
}

/**
 * What `workspace.kind` owns this entity, walking the same join chains as
 * {@link resolveEntityOrganizationId} but selecting `w.kind`.
 *
 * Returns `null` when the entity is missing or has no workspace ancestor
 * (e.g. organization- or server-scoped variables).
 */
export async function resolveWorkspaceKindForEntity(
  db: Db,
  entityType: string,
  entityId: string,
): Promise<WorkspaceKind | null> {
  switch (entityType) {
    case 'workspace': {
      const rows = await db
        .select({ kind: workspace.kind })
        .from(workspace)
        .where(eq(workspace.id, entityId))
        .limit(1)
      return kindFromRow(rows[0]?.kind)
    }
    case 'project': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind
        FROM project p
        JOIN workspace w ON w.id = p.workspace_id
        WHERE p.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    case 'environment': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind
        FROM environment e
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE e.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    case 'service': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind
        FROM service s
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE s.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    case 'hosting': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind AS kind
        FROM hosting h
        JOIN service s ON s.id = h.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE h.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    case 'container': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind AS kind
        FROM container c
        JOIN service s ON s.id = c.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE c.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    case 'managed': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind
        FROM managed m
        JOIN environment e ON e.id = m.environment_id
        JOIN project p ON p.id = e.project_id
        JOIN workspace w ON w.id = p.workspace_id
        WHERE m.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    case 'variable': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT CASE
          WHEN v.workspace_id IS NOT NULL THEN w.kind
          WHEN v.project_id IS NOT NULL THEN pw.kind
          WHEN v.environment_id IS NOT NULL THEN ew.kind
          WHEN v.service_id IS NOT NULL THEN sw.kind
          WHEN v.hosting_id IS NOT NULL THEN hw.kind
        END AS kind
        FROM variable v
        LEFT JOIN workspace w ON w.id = v.workspace_id
        LEFT JOIN project p ON p.id = v.project_id
        LEFT JOIN workspace pw ON pw.id = p.workspace_id
        LEFT JOIN environment e ON e.id = v.environment_id
        LEFT JOIN project ep ON ep.id = e.project_id
        LEFT JOIN workspace ew ON ew.id = ep.workspace_id
        LEFT JOIN service s ON s.id = v.service_id
        LEFT JOIN environment se ON se.id = s.environment_id
        LEFT JOIN project sp ON sp.id = se.project_id
        LEFT JOIN workspace sw ON sw.id = sp.workspace_id
        LEFT JOIN hosting h ON h.id = v.hosting_id
        LEFT JOIN service hs ON hs.id = h.service_id
        LEFT JOIN environment he ON he.id = hs.environment_id
        LEFT JOIN project hp ON hp.id = he.project_id
        LEFT JOIN workspace hw ON hw.id = hp.workspace_id
        WHERE v.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    case 'principal': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind AS kind
        FROM principal p
        LEFT JOIN project pr ON pr.id = p.project_id
        LEFT JOIN workspace w ON w.id = pr.workspace_id
        WHERE p.id = ${entityId}::uuid
          AND p.project_id IS NOT NULL
        LIMIT 1
      `)
      if (rows[0]?.kind) return kindFromRow(rows[0].kind)

      const managedRows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind AS kind
        FROM principal p
        JOIN managed m ON m.id = p.managed_id
        JOIN environment e ON e.id = m.environment_id
        JOIN project pr ON pr.id = e.project_id
        JOIN workspace w ON w.id = pr.workspace_id
        WHERE p.id = ${entityId}::uuid
          AND p.managed_id IS NOT NULL
        LIMIT 1
      `)
      if (managedRows[0]?.kind) return kindFromRow(managedRows[0].kind)

      const assignmentRows = await db.execute<{ kind: string }>(sql`
        SELECT w.kind AS kind
        FROM principal p
        JOIN assignment a ON a.principal_id = p.id
        JOIN service s ON s.id = a.service_id
        JOIN environment e ON e.id = s.environment_id
        JOIN project pr ON pr.id = e.project_id
        JOIN workspace w ON w.id = pr.workspace_id
        WHERE p.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(assignmentRows[0]?.kind)
    }
    case 'storage': {
      const rows = await db.execute<{ kind: string }>(sql`
        SELECT CASE
          WHEN st.project_id IS NOT NULL THEN pw.kind
          WHEN st.environment_id IS NOT NULL THEN ew.kind
          WHEN st.service_id IS NOT NULL THEN sw.kind
        END AS kind
        FROM storage st
        LEFT JOIN project p ON p.id = st.project_id
        LEFT JOIN workspace pw ON pw.id = p.workspace_id
        LEFT JOIN environment e ON e.id = st.environment_id
        LEFT JOIN project ep ON ep.id = e.project_id
        LEFT JOIN workspace ew ON ew.id = ep.workspace_id
        LEFT JOIN service s ON s.id = st.service_id
        LEFT JOIN environment se ON se.id = s.environment_id
        LEFT JOIN project sp ON sp.id = se.project_id
        LEFT JOIN workspace sw ON sw.id = sp.workspace_id
        WHERE st.id = ${entityId}::uuid
        LIMIT 1
      `)
      return kindFromRow(rows[0]?.kind)
    }
    default:
      return null
  }
}
