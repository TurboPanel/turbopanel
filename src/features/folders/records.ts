/**
 * Reads over the `folder` table that decide the naming locks:
 *
 * - an environment's name is locked while any folder row outside `common`
 *   exists under it (any state but `missing`, so a `removing` row left by an
 *   offline server still counts);
 * - a project's slug is locked while any folder row exists under one of its
 *   environments, or a site owner of the project has a `present` or `pending`
 *   placement (its directory exists or is about to);
 * - the organization's folder-name setting is locked once any folder row
 *   exists for one of its site owners.
 *
 * Nothing here writes a row. The create flows insert them in the deploy
 * transaction and must take the same row lock on the environment that the
 * rename uses, so a rename and a first folder cannot both succeed.
 */
import { and, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  command,
  environment,
  folder,
  principal,
  principalPlacement,
  project,
  server,
  service,
  storage,
} from '../../db/schema.ts'
import { TERMINAL_COMMAND_STATUSES } from '../commands/types.ts'
import { nextFreeProjectSlug, projectSlugFromName, trimHyphens } from './names.ts'

export const ENVIRONMENT_NAME_LOCKED_ERROR = 'environment_name_locked'
export const ENVIRONMENT_NAME_INVALID_ERROR = 'invalid_environment_name'
/** The plain sentence that goes with `invalid_environment_name`. */
export const ENVIRONMENT_NAME_RULE_MESSAGE =
  'An environment name uses lowercase letters, digits, hyphens and underscores, starts with a letter or digit, is at most 32 characters, and is not a reserved word such as common, home or tmp.'
export const ENVIRONMENT_DEPLOY_RUNNING_ERROR = 'environment_deploy_running'
export const ENVIRONMENT_SERVER_LOCKED_ERROR = 'environment_server_locked'
export const ENVIRONMENT_HAS_FOLDERS_ERROR = 'environment_has_folders'
export const PROJECT_SLUG_LOCKED_ERROR = 'project_slug_locked'
export const PROJECT_SLUG_IN_USE_ERROR = 'project_slug_in_use'
export const DIRECTORY_NAMES_LOCKED_ERROR = 'directory_names_locked'
export const SERVICE_SLUG_LOCKED_ERROR = 'service_slug_locked'
export const SCOPE_LOCKED_ERROR = 'scope_locked'

/** How many blocking folders an error lists. */
export const BLOCKING_FOLDER_LIMIT = 20

/** A folder row as the panel shows it: what it is, where, and in what state. */
export type BlockingFolder = {
  id: string
  kind: 'service' | 'volume'
  state: string
  scope: string
  slug: string
  serverId: string
  serverName: string | null
  /** The service or volume it belongs to; null once that row is gone. */
  assetId: string | null
  assetName: string | null
}

/** Anything that can run a select: the connection or an open transaction. */
export type Reader = Pick<Db, 'select'>

const COUNTS_TOWARD_LOCK = ne(folder.state, 'missing')

const FOLDER_COLUMNS = {
  id: folder.id,
  kind: folder.kind,
  state: folder.state,
  scope: folder.scope,
  slug: folder.slug,
  serverId: folder.serverId,
  serverName: server.name,
  serviceId: folder.serviceId,
  serviceName: service.name,
  storageId: folder.storageId,
  storageName: storage.name,
}

/**
 * Folder rows under an environment, the ones that block its rename, oldest
 * first, with the names a person can recognise. `common` folders never carry
 * the environment id, so they are not listed.
 */
export async function listEnvironmentFolders(
  db: Reader,
  environmentId: string,
  limit: number = BLOCKING_FOLDER_LIMIT
): Promise<{ folders: BlockingFolder[]; total: number }> {
  const where = and(eq(folder.environmentId, environmentId), COUNTS_TOWARD_LOCK)
  const rows = await db
    .select(FOLDER_COLUMNS)
    .from(folder)
    .innerJoin(server, eq(server.id, folder.serverId))
    .leftJoin(service, eq(service.id, folder.serviceId))
    .leftJoin(storage, eq(storage.id, folder.storageId))
    .where(where)
    .orderBy(folder.createdAt, folder.id)
    .limit(limit)
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(folder)
    .where(where)
  return {
    folders: rows.map((row) => ({
      id: row.id,
      kind: row.kind as BlockingFolder['kind'],
      state: row.state,
      scope: row.scope,
      slug: row.slug,
      serverId: row.serverId,
      serverName: row.serverName,
      assetId: row.serviceId ?? row.storageId,
      assetName: row.serviceName ?? row.storageName,
    })),
    total: counted?.total ?? rows.length,
  }
}

/** True when a folder row under the environment blocks renaming or deleting it. */
export async function environmentHasFolders(db: Reader, environmentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: folder.id })
    .from(folder)
    .where(and(eq(folder.environmentId, environmentId), COUNTS_TOWARD_LOCK))
    .limit(1)
  return row !== undefined
}

/** True while a deploy, lifecycle or stop command for the environment has not finished. */
export async function environmentHasRunningCommand(
  db: Reader,
  environmentId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: command.id })
    .from(command)
    .where(
      and(
        inArray(command.name, ['environment.deploy', 'environment.lifecycle', 'environment.stop']),
        notInArray(command.status, [...TERMINAL_COMMAND_STATUSES]),
        sql`${command.context} ->> 'environmentId' = ${environmentId}`
      )
    )
    .limit(1)
  return row !== undefined
}

/**
 * Take the environment row's lock for the rest of the transaction. A rename and
 * the first folder insert for the environment both call this first, so one
 * waits for the other and then sees its result.
 */
export async function lockEnvironmentRow(
  tx: Pick<Db, 'select'>,
  environmentId: string
): Promise<boolean> {
  const rows = await tx
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .for('update')
  return rows.length > 0
}

/** True when the project is locked: a folder under any of its environments, or a site owner directory that exists or is pending. */
export async function projectSlugIsLocked(db: Reader, projectId: string): Promise<boolean> {
  const [folderRow] = await db
    .select({ id: folder.id })
    .from(folder)
    .innerJoin(environment, eq(environment.id, folder.environmentId))
    .where(and(eq(environment.projectId, projectId), COUNTS_TOWARD_LOCK))
    .limit(1)
  if (folderRow) return true
  const [placementRow] = await db
    .select({ id: principalPlacement.id })
    .from(principalPlacement)
    .innerJoin(principal, eq(principal.id, principalPlacement.principalId))
    .where(
      and(
        eq(principal.projectId, projectId),
        inArray(principalPlacement.state, ['present', 'pending'])
      )
    )
    .limit(1)
  return placementRow !== undefined
}

/** True once any folder row exists for a site owner of the organization. */
export async function organizationHasFolders(db: Reader, organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: folder.id })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .where(eq(principal.organizationId, organizationId))
    .limit(1)
  return row !== undefined
}

/** True once a folder row exists for the service (any state, `planned` included). */
export async function serviceHasFolder(db: Reader, serviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: folder.id })
    .from(folder)
    .where(eq(folder.serviceId, serviceId))
    .limit(1)
  return row !== undefined
}

/** True once a folder row exists for the volume (any state, `planned` included). */
export async function storageHasFolder(db: Reader, storageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: folder.id })
    .from(folder)
    .where(eq(folder.storageId, storageId))
    .limit(1)
  return row !== undefined
}

/** Project slugs already used in the organization, for choosing a free one. */
export async function loadProjectSlugs(db: Reader, organizationId: string): Promise<Set<string>> {
  const rows = await db
    .select({ slug: project.slug })
    .from(project)
    .where(and(eq(project.organizationId, organizationId), isNotNull(project.slug)))
  return new Set(rows.flatMap((row) => (row.slug ? [row.slug] : [])))
}

/**
 * A slug for a new project in the organization, from its name; `-2` to `-99`
 * on a clash. The unique index is the final guard if two creates race.
 */
export async function allocateProjectSlug(
  db: Reader,
  organizationId: string,
  name: string | null | undefined
): Promise<string> {
  const taken = await loadProjectSlugs(db, organizationId)
  const base = projectSlugFromName(name)
  return (
    nextFreeProjectSlug(base, (slug) => taken.has(slug)) ??
    `${trimHyphens(base.slice(0, 31))}-${crypto.randomUUID().slice(0, 8)}`
  )
}
