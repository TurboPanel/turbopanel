/**
 * The organization-wide view of folders that need a person: orphans (on a
 * server with no service or volume that owns them), folders still being
 * removed, and folders the host no longer has. The per-environment list in
 * `records.ts` shows the same rows under one environment; this one reads across
 * every project so an admin can find and settle them in one place.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { folder, principal, server, service, storage } from '../../db/schema.ts'
import { type BlockingFolder, blockingReason, type Reader } from './records.ts'

/** The states a person can act on or wait for. */
export const ATTENTION_FOLDER_STATES = ['orphan', 'removing', 'missing'] as const
export type AttentionFolderState = (typeof ATTENTION_FOLDER_STATES)[number]

/** Rows one page returns at most. */
export const FOLDER_ADMIN_PAGE_LIMIT = 100

export type AdminFolder = BlockingFolder & {
  /** The site owner's Linux user whose tree holds the folder. */
  owner: string
  /** Set while a service or volume row still names the folder. */
  hasAsset: boolean
  /** What a person can do now: remove an orphan, retry a removal, forget a missing row, or nothing. */
  action: 'remove' | 'retry' | 'forget' | null
  updatedAt: string
}

function actionFor(state: string, hasAsset: boolean): AdminFolder['action'] {
  // An orphan that a service or volume row still names goes with that row.
  if (state === 'orphan') return hasAsset ? null : 'remove'
  if (state === 'removing') return 'retry'
  if (state === 'missing') return 'forget'
  return null
}

/** Folder rows of the organization's site owners in the wanted states, newest change first. */
export async function listOrganizationFolders(
  db: Reader,
  organizationId: string,
  options: { states?: readonly AttentionFolderState[]; limit?: number; offset?: number } = {}
): Promise<{ folders: AdminFolder[]; total: number }> {
  const states = options.states?.length ? options.states : ATTENTION_FOLDER_STATES
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), FOLDER_ADMIN_PAGE_LIMIT)
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0)
  const where = and(
    eq(principal.organizationId, organizationId),
    inArray(folder.state, [...states])
  )
  const rows = await db
    .select({
      id: folder.id,
      kind: folder.kind,
      state: folder.state,
      scope: folder.scope,
      slug: folder.slug,
      serverId: folder.serverId,
      serverName: server.name,
      serverConnected: server.isConnected,
      serviceId: folder.serviceId,
      serviceName: service.name,
      storageId: folder.storageId,
      storageName: storage.name,
      removalNote: folder.removalNote,
      owner: principal.appliedUsername,
      updatedAt: folder.updatedAt,
    })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .innerJoin(server, eq(server.id, folder.serverId))
    .leftJoin(service, eq(service.id, folder.serviceId))
    .leftJoin(storage, eq(storage.id, folder.storageId))
    .where(where)
    .orderBy(sql`${folder.updatedAt} desc`, folder.id)
    .limit(limit)
    .offset(offset)
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .where(where)
  return {
    folders: rows.map((row) => {
      const hasAsset = row.serviceId !== null || row.storageId !== null
      return {
        id: row.id,
        kind: row.kind as AdminFolder['kind'],
        state: row.state,
        scope: row.scope,
        slug: row.slug,
        serverId: row.serverId,
        serverName: row.serverName,
        assetId: row.serviceId ?? row.storageId,
        assetName: row.serviceName ?? row.storageName,
        reason: blockingReason(row.state, row.serverName, row.serverConnected, row.removalNote),
        owner: row.owner,
        hasAsset,
        action: actionFor(row.state, hasAsset),
        updatedAt: row.updatedAt,
      }
    }),
    total: counted?.total ?? rows.length,
  }
}

/** The organization a folder row belongs to (through its site owner), or null. */
export async function folderOrganizationId(db: Reader, folderId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: principal.organizationId })
    .from(folder)
    .innerJoin(principal, eq(principal.id, folder.principalId))
    .where(eq(folder.id, folderId))
    .limit(1)
  return row?.organizationId ?? null
}

/** One folder row for a settle action. */
export async function loadFolderForAction(
  db: Reader,
  folderId: string
): Promise<{
  id: string
  serverId: string
  state: string
  hasAsset: boolean
  kind: 'service' | 'volume'
  scope: string
  slug: string
} | null> {
  const [row] = await db
    .select({
      id: folder.id,
      serverId: folder.serverId,
      state: folder.state,
      serviceId: folder.serviceId,
      storageId: folder.storageId,
      kind: folder.kind,
      scope: folder.scope,
      slug: folder.slug,
    })
    .from(folder)
    .where(eq(folder.id, folderId))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    serverId: row.serverId,
    state: row.state,
    hasAsset: row.serviceId !== null || row.storageId !== null,
    kind: row.kind as 'service' | 'volume',
    scope: row.scope,
    slug: row.slug,
  }
}

/** Forget a `missing` row: the host does not have the folder, so there is nothing to remove. */
export async function forgetMissingFolder(
  db: Pick<Db, 'delete'>,
  folderId: string
): Promise<boolean> {
  const deleted = await db
    .delete(folder)
    .where(and(eq(folder.id, folderId), eq(folder.state, 'missing')))
    .returning({ id: folder.id })
  return deleted.length > 0
}
