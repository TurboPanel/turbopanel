import type { Context } from 'hono'
import { asc, eq, inArray } from 'drizzle-orm'
import { environment, project, workspace } from '../../db/schema.ts'
import { mergeProjectDefaultServer } from '../../features/projects/project-options.ts'
import {
  defineCachedRead,
  versionStamp,
  versionStampColumn,
  withoutVersionStamp,
  type CachedReadDb,
} from '../cached-read.ts'

/**
 * Approved cached read models for the projects, environments and workspaces
 * screens: the list rows, and the single-row detail for projects and
 * environments.
 *
 * Each cached statement is one SELECT on one table, with no join, no secret
 * column and no volatile function:
 *   projects-list      SELECT <project columns>, $stamp FROM project
 *                      WHERE id IN (:visibleIds) ORDER BY created_at
 *   project-detail     SELECT <project columns>, $stamp FROM project
 *                      WHERE id = :id LIMIT 1
 *   environments-list  same shape on environment
 *   environment-detail same shape on environment
 *   workspaces-list    SELECT <workspace columns>, $stamp FROM workspace
 *                      WHERE id IN (:visibleIds) ORDER BY created_at, id
 *
 * Who may see what is decided on the primary connection before any of these
 * run: lists receive the ids `listVisibleVersions` allowed for this person
 * (so the allowed set is part of the statement and therefore of the cache key),
 * and details are only returned after the route's own read check passes.
 * The version stamp is built from the id and last change of the rows, which the
 * primary connection returned in the same request, so an edit shows at once.
 * The `workspaceId` / `projectId` list filters are applied by the route after
 * the read, so the statement is the same for every filter.
 */

export type ProjectRow = {
  id: string
  name: string | null
  slug: string | null
  description: string | null
  workspaceId: string
  repositoryId: string | null
  metadata: typeof project.$inferSelect.metadata
  options: typeof project.$inferSelect.options
  createdAt: string
  updatedAt: string
}

export type EnvironmentRow = {
  id: string
  name: string | null
  description: string | null
  projectId: string
  serverId: string | null
  metadata: typeof environment.$inferSelect.metadata
  options: typeof environment.$inferSelect.options
  createdAt: string
  updatedAt: string
}

export type WorkspaceRow = {
  id: string
  name: string | null
  description: string | null
  kind: typeof workspace.$inferSelect.kind
  organizationId: string
  createdAt: string
  updatedAt: string
}

type ListInput = { organizationId: string; ids: string[]; stamp: string }
type DetailInput = { organizationId: string; id: string; stamp: string }

const projectColumns = {
  id: project.id,
  name: project.name,
  slug: project.slug,
  description: project.description,
  workspaceId: project.workspaceId,
  repositoryId: project.repositoryId,
  metadata: project.metadata,
  options: project.options,
  defaultServerId: project.defaultServerId,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
}

const environmentColumns = {
  id: environment.id,
  name: environment.name,
  description: environment.description,
  projectId: environment.projectId,
  serverId: environment.serverId,
  metadata: environment.metadata,
  options: environment.options,
  createdAt: environment.createdAt,
  updatedAt: environment.updatedAt,
}

const workspaceColumns = {
  id: workspace.id,
  name: workspace.name,
  description: workspace.description,
  kind: workspace.kind,
  organizationId: workspace.organizationId,
  createdAt: workspace.createdAt,
  updatedAt: workspace.updatedAt,
}

/** The API carries the default placement server inside `options`; it is stored in its own column. */
function withDefaultServerInOptions(
  row: ProjectRow & { defaultServerId: string | null }
): ProjectRow {
  const { defaultServerId, ...rest } = row
  return { ...rest, options: mergeProjectDefaultServer(rest.options, defaultServerId) }
}

function dropStamp<Row extends { _v?: unknown }>(rows: Row[]): Array<Omit<Row, '_v'>> {
  return rows.map((row) => withoutVersionStamp(row))
}

export const projectsListCachedRead = defineCachedRead({
  id: 'projects-list',
  scope: (input: ListInput) => [input.organizationId],
  build: (db: CachedReadDb, input: ListInput) =>
    db
      .select({ ...projectColumns, _v: versionStampColumn(input.stamp) })
      .from(project)
      .where(inArray(project.id, input.ids))
      .orderBy(project.createdAt),
  transform: (rows): ProjectRow[] => dropStamp(rows).map(withDefaultServerInOptions),
  samples: [
    { organizationId: 'org-1', ids: ['p-1'], stamp: 'stamp-a' },
    { organizationId: 'org-1', ids: ['p-1', 'p-2', 'p-3'], stamp: 'stamp-b' },
  ],
})

export const projectDetailCachedRead = defineCachedRead({
  id: 'project-detail',
  scope: (input: DetailInput) => [input.organizationId],
  build: (db: CachedReadDb, input: DetailInput) =>
    db
      .select({ ...projectColumns, _v: versionStampColumn(input.stamp) })
      .from(project)
      .where(eq(project.id, input.id))
      .limit(1),
  transform: (rows): ProjectRow | null => {
    const [first] = dropStamp(rows)
    return first ? withDefaultServerInOptions(first) : null
  },
  samples: [{ organizationId: 'org-1', id: 'p-1', stamp: 'stamp-a' }],
})

export const environmentsListCachedRead = defineCachedRead({
  id: 'environments-list',
  scope: (input: ListInput) => [input.organizationId],
  build: (db: CachedReadDb, input: ListInput) =>
    db
      .select({ ...environmentColumns, _v: versionStampColumn(input.stamp) })
      .from(environment)
      .where(inArray(environment.id, input.ids))
      .orderBy(environment.createdAt),
  transform: (rows): EnvironmentRow[] => dropStamp(rows) as EnvironmentRow[],
  samples: [
    { organizationId: 'org-1', ids: ['e-1'], stamp: 'stamp-a' },
    { organizationId: 'org-1', ids: ['e-1', 'e-2', 'e-3'], stamp: 'stamp-b' },
  ],
})

export const environmentDetailCachedRead = defineCachedRead({
  id: 'environment-detail',
  scope: (input: DetailInput) => [input.organizationId],
  build: (db: CachedReadDb, input: DetailInput) =>
    db
      .select({ ...environmentColumns, _v: versionStampColumn(input.stamp) })
      .from(environment)
      .where(eq(environment.id, input.id))
      .limit(1),
  transform: (rows): EnvironmentRow | null =>
    (dropStamp(rows)[0] as EnvironmentRow | undefined) ?? null,
  samples: [{ organizationId: 'org-1', id: 'e-1', stamp: 'stamp-a' }],
})

export const workspacesListCachedRead = defineCachedRead({
  id: 'workspaces-list',
  scope: (input: ListInput) => [input.organizationId],
  build: (db: CachedReadDb, input: ListInput) =>
    db
      .select({ ...workspaceColumns, _v: versionStampColumn(input.stamp) })
      .from(workspace)
      .where(inArray(workspace.id, input.ids))
      // Secondary `id` breaks ties when same-transaction inserts share `created_at`
      // so System precedes Default Workspace.
      .orderBy(asc(workspace.createdAt), asc(workspace.id)),
  transform: (rows): WorkspaceRow[] => dropStamp(rows) as WorkspaceRow[],
  samples: [
    { organizationId: 'org-1', ids: ['w-1'], stamp: 'stamp-a' },
    { organizationId: 'org-1', ids: ['w-1', 'w-2', 'w-3'], stamp: 'stamp-b' },
  ],
})

type Visible = { id: string; updatedAt: string }

/** Stamp for a list: the id and last change of every visible row, in id order. */
function listInput(organizationId: string, visible: Visible[]): ListInput {
  const sorted = [...visible].sort((a, b) => a.id.localeCompare(b.id))
  return {
    organizationId,
    ids: sorted.map((v) => v.id),
    stamp: versionStamp(sorted.flatMap((v) => [v.id, v.updatedAt])),
  }
}

function detailInput(organizationId: string, id: string, updatedAt: string): DetailInput {
  return { organizationId, id, stamp: versionStamp([id, updatedAt]) }
}

export type VisibleRows = { organizationId: string; visible: Visible[] }
export type DetailTarget = { organizationId: string; id: string; updatedAt: string }

export async function cachedProjectsList(c: Context, opts: VisibleRows): Promise<ProjectRow[]> {
  if (opts.visible.length === 0) return []
  return projectsListCachedRead(c, listInput(opts.organizationId, opts.visible))
}

export function cachedProjectDetail(c: Context, opts: DetailTarget): Promise<ProjectRow | null> {
  return projectDetailCachedRead(c, detailInput(opts.organizationId, opts.id, opts.updatedAt))
}

export async function cachedEnvironmentsList(
  c: Context,
  opts: VisibleRows
): Promise<EnvironmentRow[]> {
  if (opts.visible.length === 0) return []
  return environmentsListCachedRead(c, listInput(opts.organizationId, opts.visible))
}

export function cachedEnvironmentDetail(
  c: Context,
  opts: DetailTarget
): Promise<EnvironmentRow | null> {
  return environmentDetailCachedRead(c, detailInput(opts.organizationId, opts.id, opts.updatedAt))
}

export async function cachedWorkspacesList(c: Context, opts: VisibleRows): Promise<WorkspaceRow[]> {
  if (opts.visible.length === 0) return []
  return workspacesListCachedRead(c, listInput(opts.organizationId, opts.visible))
}
