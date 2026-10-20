/**
 * The primary environment of a project.
 *
 * A project has exactly one primary environment, stored as `environment.is_primary`
 * (a partial unique index keeps it to one). It is the first environment created,
 * it can be changed with "make primary", and it is what the landing, the status
 * and "start a new environment as a copy" use. Nothing guesses it from a name.
 */
import { and, asc, eq, ne, sql, type SQL } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment } from '../../db/schema.ts'

type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Reader = Db

export const PRIMARY_ENVIRONMENT_DELETE_ERROR = 'primary_environment_cannot_be_deleted'

/**
 * Value for `environment.is_primary` on an insert: true when the project has no
 * environment yet. Evaluated inside the insert; callers that can race another
 * create lock the project row first ({@link lockProjectForEnvironmentChange}).
 */
export function isFirstEnvironmentOf(projectId: string): SQL<boolean> {
  return sql<boolean>`NOT EXISTS (SELECT 1 FROM "environment" AS "e" WHERE "e"."project_id" = ${projectId}::uuid)`
}

/** Serialises creates, deletes and "make primary" for one project. */
export async function lockProjectForEnvironmentChange(
  tx: Reader,
  projectId: string
): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM "project" WHERE "id" = ${projectId}::uuid FOR UPDATE`)
}

export async function loadPrimaryEnvironment(
  db: Reader,
  projectId: string
): Promise<{ id: string; name: string; serverId: string | null; options: unknown } | null> {
  const [row] = await db
    .select({
      id: environment.id,
      name: environment.name,
      serverId: environment.serverId,
      options: environment.options,
    })
    .from(environment)
    .where(and(eq(environment.projectId, projectId), eq(environment.isPrimary, true)))
    .limit(1)
  return row ?? null
}

/** Environment ids of a project, oldest first. */
export async function listProjectEnvironmentIds(db: Reader, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: environment.id })
    .from(environment)
    .where(eq(environment.projectId, projectId))
    .orderBy(asc(environment.createdAt), asc(environment.id))
  return rows.map((row) => row.id)
}

/** The marker could not be moved the way the project lock says it should. */
export class PrimaryEnvironmentConflictError extends Error {
  constructor() {
    super('primary environment marker did not change exactly one row')
    this.name = 'PrimaryEnvironmentConflictError'
  }
}

/**
 * Move the marker to `environmentId`. Two statements on purpose: the unique
 * index is checked row by row, so one swapping UPDATE could trip it. The second
 * must change exactly one row, otherwise the caller's transaction rolls back
 * (throws {@link PrimaryEnvironmentConflictError}).
 * @returns false when the environment is not in the project
 */
export async function setPrimaryEnvironment(
  tx: DbTx,
  projectId: string,
  environmentId: string
): Promise<boolean> {
  await lockProjectForEnvironmentChange(tx, projectId)
  const [target] = await tx
    .select({ id: environment.id, isPrimary: environment.isPrimary })
    .from(environment)
    .where(and(eq(environment.id, environmentId), eq(environment.projectId, projectId)))
    .limit(1)
  if (!target) return false
  if (target.isPrimary) return true
  const now = new Date().toISOString()
  await tx
    .update(environment)
    .set({ isPrimary: false, updatedAt: now })
    .where(and(eq(environment.projectId, projectId), eq(environment.isPrimary, true)))
  const set = await tx
    .update(environment)
    .set({ isPrimary: true, updatedAt: now })
    .where(eq(environment.id, environmentId))
    .returning({ id: environment.id })
  if (set.length !== 1) throw new PrimaryEnvironmentConflictError()
  return true
}

/**
 * True when deleting the environment would leave its project without a primary
 * while other environments remain. Takes the project lock first and reads the
 * marker under it, so a "make primary" racing the delete is seen.
 */
export async function deleteWouldOrphanPrimary(tx: DbTx, environmentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ projectId: environment.projectId })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!row) return false
  await lockProjectForEnvironmentChange(tx, row.projectId)
  const [current] = await tx
    .select({ isPrimary: environment.isPrimary })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!current?.isPrimary) return false
  const others = await tx
    .select({ id: environment.id })
    .from(environment)
    .where(and(eq(environment.projectId, row.projectId), ne(environment.id, environmentId)))
    .limit(1)
  return others.length > 0
}

/**
 * Primary first, pinned next, then oldest first, within each project. Projects
 * keep the order they first appear in.
 */
export function sortEnvironmentsForDisplay<
  T extends { projectId: string; isPrimary: boolean; isPinned: boolean; createdAt: string },
>(rows: readonly T[]): T[] {
  const rank = (row: T): number => {
    if (row.isPrimary) return 0
    return row.isPinned ? 1 : 2
  }
  const byAge = (a: T, b: T): number => a.createdAt.localeCompare(b.createdAt)
  const byProject = new Map<string, T[]>()
  for (const row of rows) {
    const group = byProject.get(row.projectId)
    if (group) group.push(row)
    else byProject.set(row.projectId, [row])
  }
  return [...byProject.values()].flatMap((group) =>
    group.toSorted((a, b) => rank(a) - rank(b) || byAge(a, b))
  )
}
