/**
 * Which site owners (principals) a project delete takes with it.
 *
 * A principal the project owned goes with the project when nothing outside
 * the project uses it: no service, database login, binding, kept volume or
 * secret elsewhere, and no folder that is not already being removed. Such a
 * principal is marked (`removal_requested_at`) inside the delete's
 * transaction; the removal sweep deletes the row and retires the host account
 * (user, group, home) once the host has confirmed every folder gone, so the
 * home is never removed while the folders in it are still being cleared. Any
 * other principal is kept and listed with what still uses it.
 *
 * The same reading answers the delete preview before anything changes: the
 * rows the delete would remove are left out of the counts.
 */
import { and, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Db } from '../../db/connection.ts'
import { binding, folder, login, principal, secret, storage, tenancy } from '../../db/schema.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { PrincipalReferences } from './store.ts'

/** The rows a delete removes; uses by them do not keep a principal. */
export type PrincipalDeleteScope = {
  environmentIds: readonly string[]
  serviceIds: readonly string[]
  /** Volumes deleted with the project (`retention = 'delete'`). */
  storageIds: readonly string[]
}

export type ProjectPrincipalFate = {
  /** Removed with the project: row, Linux user and home. */
  removed: Array<{ id: string; username: string }>
  /** Kept: something outside the project still uses it. */
  kept: Array<{ id: string; username: string; usedBy: PrincipalReferences }>
}

/** `column` is NULL or not one of `ids` (a NULL column never matches `NOT IN`). */
function outside(column: AnyPgColumn, ids: readonly string[]) {
  return ids.length === 0 ? undefined : or(isNull(column), notInArray(column, [...ids]))
}

/**
 * What uses a principal apart from the rows in `scope`. Folders already being
 * removed do not count: the removal sweep waits for them instead.
 */
export async function countPrincipalReferencesOutside(
  db: Pick<Db, 'select'>,
  principalId: string,
  scope: PrincipalDeleteScope
): Promise<PrincipalReferences> {
  const total = async (
    table: typeof tenancy | typeof storage | typeof secret | typeof login | typeof folder,
    extra: ReturnType<typeof and>
  ): Promise<number> => {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.principalId, principalId), extra))
    return row?.total ?? 0
  }
  const [bound] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .where(and(eq(login.principalId, principalId), outside(binding.serviceId, scope.serviceIds)))
  return {
    tenancies: await total(tenancy, and(outside(tenancy.serviceId, scope.serviceIds))),
    bindings: bound?.total ?? 0,
    storages: await total(storage, and(outside(storage.id, scope.storageIds))),
    secrets: await total(secret, undefined),
    logins: await total(login, undefined),
    folders: await total(
      folder,
      and(
        ne(folder.state, 'removing'),
        outside(folder.environmentId, scope.environmentIds),
        outside(folder.serviceId, scope.serviceIds),
        outside(folder.storageId, scope.storageIds)
      )
    ),
  }
}

/** Which of the project's principals go with it and which stay (nothing is written). */
export async function classifyProjectPrincipals(
  db: Pick<Db, 'select'>,
  projectId: string,
  scope: PrincipalDeleteScope
): Promise<ProjectPrincipalFate> {
  const rows = await db
    .select({ id: principal.id, username: principal.appliedUsername })
    .from(principal)
    .where(eq(principal.projectId, projectId))
  const sorted = [...rows].sort((a, b) => a.username.localeCompare(b.username))
  const fate: ProjectPrincipalFate = { removed: [], kept: [] }
  await forEachSequential(sorted, async (row) => {
    const usedBy = await countPrincipalReferencesOutside(db, row.id, scope)
    if (Object.values(usedBy).some((count) => count > 0)) fate.kept.push({ ...row, usedBy })
    else fate.removed.push(row)
  })
  return fate
}

/**
 * Inside the project delete, after the project's own rows are gone and before
 * the project row goes (its principals still name it): mark the principals
 * nothing else uses for the removal sweep.
 */
export async function requestProjectPrincipalRemoval(
  tx: Pick<Db, 'select' | 'update'>,
  projectId: string,
  scope: PrincipalDeleteScope
): Promise<ProjectPrincipalFate> {
  const fate = await classifyProjectPrincipals(tx, projectId, scope)
  if (fate.removed.length > 0) {
    await tx
      .update(principal)
      .set({ removalRequestedAt: sql`now()` })
      .where(
        inArray(
          principal.id,
          fate.removed.map((row) => row.id)
        )
      )
  }
  return fate
}
