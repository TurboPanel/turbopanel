/**
 * Finding the admin tools of one Database Cluster. A tool is an ordinary
 * project whose `metadata` says so, so no table is needed:
 * `{ code: 'admin-tool', tool, managedId, loginId, hostname, access, image, revision, email? }`.
 * Nothing here is secret.
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../../db/connection.ts'
import { binding, environment, login, project, scope, service } from '../../../db/schema.ts'
import {
  ADMIN_TOOL_PROJECT_CODE,
  ADMIN_TOOL_SERVICE,
  ADMIN_TOOLS,
  type AdminToolId,
  isAdminToolId,
} from './templates.ts'

export type AdminToolAccess = 'admin' | 'read-only'

export type AdminToolMetadata = {
  code: typeof ADMIN_TOOL_PROJECT_CODE
  tool: AdminToolId
  managedId: string
  loginId: string
  /** The login's name, shown on the card. */
  loginName: string
  hostname: string
  access: AdminToolAccess
  image: string
  revision: number
  /** pgAdmin's sign-in email. */
  email?: string
}

export type AdminToolProject = {
  projectId: string
  environmentId: string
  name: string | null
  meta: AdminToolMetadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads project metadata as a tool's, or `null` when it is not one of ours. */
export function parseAdminToolMetadata(value: unknown): AdminToolMetadata | null {
  if (!isRecord(value) || value.code !== ADMIN_TOOL_PROJECT_CODE) return null
  const { tool, managedId, loginId, loginName, hostname, access, image, revision, email } = value
  if (!isAdminToolId(tool)) return null
  if (typeof managedId !== 'string' || typeof loginId !== 'string') return null
  if (typeof hostname !== 'string' || typeof image !== 'string') return null
  if (access !== 'admin' && access !== 'read-only') return null
  return {
    code: ADMIN_TOOL_PROJECT_CODE,
    tool,
    managedId,
    loginId,
    loginName: typeof loginName === 'string' ? loginName : '',
    hostname,
    access,
    image,
    revision: typeof revision === 'number' ? revision : 1,
    ...(typeof email === 'string' ? { email } : {}),
  }
}

/** The metadata a new tool project carries. */
export function adminToolMetadata(
  input: Omit<AdminToolMetadata, 'code' | 'image'>
): AdminToolMetadata {
  return { code: ADMIN_TOOL_PROJECT_CODE, image: ADMIN_TOOLS[input.tool].image, ...input }
}

/**
 * A project is a tool of this cluster only when its metadata says so **and**
 * its `tool` service is bound to a login of this cluster. The login comes from
 * that binding, never from metadata, so a project made by hand with copied
 * metadata is not a tool and cannot point at someone else's login.
 */
function toolRows(db: Db, managedId: string) {
  return db
    .select({
      projectId: project.id,
      name: project.name,
      metadata: project.metadata,
      environmentId: environment.id,
      loginId: login.id,
    })
    .from(project)
    .innerJoin(
      environment,
      and(eq(environment.projectId, project.id), eq(environment.isPrimary, true))
    )
    .innerJoin(
      service,
      and(
        eq(service.environmentId, environment.id),
        eq(service.composeServiceName, ADMIN_TOOL_SERVICE)
      )
    )
    .innerJoin(binding, eq(binding.serviceId, service.id))
    .innerJoin(login, and(eq(login.id, binding.loginId), eq(login.managedId, managedId)))
}

/** The admin tools of a cluster, oldest first, each with its primary environment. */
export async function listAdminTools(
  db: Db,
  managedId: string,
  organizationId: string
): Promise<AdminToolProject[]> {
  const rows = await toolRows(db, managedId)
    .where(
      and(
        eq(project.organizationId, organizationId),
        sql`${project.metadata}->>'code' = ${ADMIN_TOOL_PROJECT_CODE}`,
        sql`${project.metadata}->>'managedId' = ${managedId}`
      )
    )
    .orderBy(asc(project.createdAt))
  return rows.flatMap((row) => {
    const meta = parseAdminToolMetadata(row.metadata)
    return meta
      ? [
          {
            projectId: row.projectId,
            environmentId: row.environmentId,
            name: row.name,
            meta: { ...meta, loginId: row.loginId },
          },
        ]
      : []
  })
}

/** One tool of this cluster, or `undefined` for a project that is not one of its tools. */
export async function findAdminTool(
  db: Db,
  managedId: string,
  organizationId: string,
  projectId: string
): Promise<AdminToolProject | undefined> {
  const tools = await listAdminTools(db, managedId, organizationId)
  return tools.find((tool) => tool.projectId === projectId)
}

/**
 * The logins the cluster's admin tools sign in with. They get an explicit
 * grant on every database (not the All Databases switch, so that switch keeps
 * governing ordinary logins), and this is the list kept in step.
 */
export async function adminToolLoginIds(db: Db, managedId: string): Promise<string[]> {
  const rows = await toolRows(db, managedId).where(
    and(
      sql`${project.metadata}->>'code' = ${ADMIN_TOOL_PROJECT_CODE}`,
      sql`${project.metadata}->>'managedId' = ${managedId}`
    )
  )
  return [...new Set(rows.map((row) => row.loginId))]
}

/**
 * Lists new databases on every admin tool login of the cluster, so a tool
 * sees a database made after it. One statement; a repeat is a no-op.
 */
export async function addDatabasesToAdminToolLogins(
  db: Db,
  managedId: string,
  databaseIds: readonly string[]
): Promise<void> {
  if (databaseIds.length === 0) return
  const loginIds = await adminToolLoginIds(db, managedId)
  if (loginIds.length === 0) return
  const values = loginIds.flatMap((loginId) =>
    databaseIds.map((databaseId) => ({ loginId, databaseId }))
  )
  await db.insert(scope).values(values).onConflictDoNothing()
}
