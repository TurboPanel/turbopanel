/**
 * Common assets and the environments that use them.
 *
 * A common service or volume belongs to a site owner (the Linux user on a
 * server), lives in that owner's `common` folder scope, and is not tied to one
 * environment's name. Any environment of any project in the organization can
 * use it; the `share` table records that use. It changes three rules:
 *
 * - deleting an environment removes its rows (the foreign key cascades);
 * - deleting a common asset is refused while any other environment uses it;
 * - a common folder never blocks an environment rename (its folder row carries
 *   no environment id), and using one does not either.
 *
 * The environment the asset was created in still anchors its row (a service
 * always has an environment); that environment uses its own asset without a
 * `share` row.
 */
import { and, eq, inArray, notInArray, or } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, project, service, share, storage } from '../../db/schema.ts'
import type { Reader } from './records.ts'

export const COMMON_ASSET_IN_USE_ERROR = 'common_asset_in_use'
export const ASSET_NOT_COMMON_ERROR = 'asset_not_common'

/** One use of a common asset by an environment, with names a person can recognise. */
export type SharedUse = {
  id: string
  environmentId: string
  environmentName: string | null
  projectId: string
  projectName: string | null
  kind: 'service' | 'volume'
  assetId: string
  assetName: string | null
}

/** How many uses an error lists. */
export const SHARED_USE_LIMIT = 20

const USE_COLUMNS = {
  id: share.id,
  environmentId: share.environmentId,
  environmentName: environment.name,
  projectId: project.id,
  projectName: project.name,
  serviceId: share.serviceId,
  serviceName: service.name,
  storageId: share.storageId,
  storageName: storage.name,
}

function toUse(row: {
  id: string
  environmentId: string
  environmentName: string | null
  projectId: string
  projectName: string | null
  serviceId: string | null
  serviceName: string | null
  storageId: string | null
  storageName: string | null
}): SharedUse {
  const isService = row.serviceId !== null
  return {
    id: row.id,
    environmentId: row.environmentId,
    environmentName: row.environmentName,
    projectId: row.projectId,
    projectName: row.projectName,
    kind: isService ? 'service' : 'volume',
    assetId: (row.serviceId ?? row.storageId) as string,
    assetName: isService ? row.serviceName : row.storageName,
  }
}

function baseSelect(db: Reader) {
  return db
    .select(USE_COLUMNS)
    .from(share)
    .innerJoin(environment, eq(environment.id, share.environmentId))
    .innerJoin(project, eq(project.id, environment.projectId))
    .leftJoin(service, eq(service.id, share.serviceId))
    .leftJoin(storage, eq(storage.id, share.storageId))
}

/** The common assets an environment uses, oldest first. */
export async function listEnvironmentShares(
  db: Reader,
  environmentId: string
): Promise<SharedUse[]> {
  const rows = await baseSelect(db)
    .where(eq(share.environmentId, environmentId))
    .orderBy(share.createdAt, share.id)
  return rows.map(toUse)
}

/**
 * Uses of the given assets by environments other than `exceptEnvironmentIds`
 * (the environments being deleted along with them). Empty when nothing else
 * uses them, so the assets can go.
 */
export async function listUsesOfAssets(
  db: Reader,
  assets: { serviceIds?: readonly string[]; storageIds?: readonly string[] },
  exceptEnvironmentIds: readonly string[] = [],
  limit: number = SHARED_USE_LIMIT
): Promise<SharedUse[]> {
  const serviceIds = assets.serviceIds ?? []
  const storageIds = assets.storageIds ?? []
  if (serviceIds.length === 0 && storageIds.length === 0) return []
  const rows = await baseSelect(db)
    .where(
      and(
        or(
          serviceIds.length > 0 ? inArray(share.serviceId, [...serviceIds]) : undefined,
          storageIds.length > 0 ? inArray(share.storageId, [...storageIds]) : undefined
        ),
        exceptEnvironmentIds.length > 0
          ? notInArray(share.environmentId, [...exceptEnvironmentIds])
          : undefined
      )
    )
    .orderBy(share.createdAt, share.id)
    .limit(limit)
  return rows.map(toUse)
}

/** The refusal body for deleting a common asset another environment uses. */
export function inUseBody(uses: readonly SharedUse[]) {
  return {
    error: COMMON_ASSET_IN_USE_ERROR as typeof COMMON_ASSET_IN_USE_ERROR,
    message:
      'Other environments still use this shared service or volume. Stop using it in each of them first, then delete it.',
    uses,
  }
}

/** Record that an environment uses a common asset. Idempotent. Returns the row id. */
export async function insertShare(
  db: Pick<Db, 'insert' | 'select'>,
  input: { environmentId: string; serviceId?: string; storageId?: string }
): Promise<string> {
  await db
    .insert(share)
    .values({
      environmentId: input.environmentId,
      serviceId: input.serviceId ?? null,
      storageId: input.storageId ?? null,
    })
    .onConflictDoNothing()
  const [row] = await db
    .select({ id: share.id })
    .from(share)
    .where(
      and(
        eq(share.environmentId, input.environmentId),
        input.serviceId === undefined
          ? eq(share.storageId, input.storageId as string)
          : eq(share.serviceId, input.serviceId)
      )
    )
    .limit(1)
  return (row as { id: string }).id
}

/** Stop using a common asset. True when a row was removed. */
export async function deleteShare(
  db: Pick<Db, 'delete'>,
  environmentId: string,
  shareId: string
): Promise<boolean> {
  const removed = await db
    .delete(share)
    .where(and(eq(share.id, shareId), eq(share.environmentId, environmentId)))
    .returning({ id: share.id })
  return removed.length > 0
}

/** Ids of the common volumes an environment uses (for the deploy payload). */
export async function sharedVolumeIds(db: Reader, environmentId: string): Promise<string[]> {
  const rows = await db
    .select({ storageId: share.storageId })
    .from(share)
    .where(eq(share.environmentId, environmentId))
  return rows.flatMap((row) => (typeof row.storageId === 'string' ? [row.storageId] : []))
}
