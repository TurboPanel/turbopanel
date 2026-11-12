import { eq } from 'drizzle-orm'
import type { Db } from '../db/connection.ts'
import { environment, principal, project, server } from '../db/schema.ts'
import { confirmationName } from '../client/confirm-name.ts'

/** The kinds of delete that need `?confirmName=` and read the name from a row. */
export type ConfirmNameKind = 'server' | 'project' | 'environment' | 'managed' | 'principal'

/**
 * The name a gated delete expects for `id`, read the way the route reads it
 * (a server falls back to its hostname, everything to its id; a managed
 * database goes by its project's name, `id` being the environment; a Hosting
 * Account by its username).
 */
export async function confirmNameFor(db: Db, kind: ConfirmNameKind, id: string): Promise<string> {
  if (kind === 'server') {
    const [row] = await db
      .select({ name: server.name, hostname: server.hostname })
      .from(server)
      .where(eq(server.id, id))
      .limit(1)
    return confirmationName(row?.name, row?.hostname, id)
  }
  if (kind === 'project') {
    const [row] = await db
      .select({ name: project.name })
      .from(project)
      .where(eq(project.id, id))
      .limit(1)
    return confirmationName(row?.name, id)
  }
  if (kind === 'principal') {
    const [row] = await db
      .select({ username: principal.username })
      .from(principal)
      .where(eq(principal.id, id))
      .limit(1)
    return row?.username ?? ''
  }
  if (kind === 'environment') {
    const [row] = await db
      .select({ name: environment.name })
      .from(environment)
      .where(eq(environment.id, id))
      .limit(1)
    return confirmationName(row?.name, id)
  }
  const [row] = await db
    .select({ name: project.name, projectId: project.id })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(eq(environment.id, id))
    .limit(1)
  return confirmationName(row?.name, row?.projectId, id)
}

/** `path` with `confirmName=<name>` added to its query. */
export function withConfirmName(path: string, name: string): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}${new URLSearchParams({ confirmName: name }).toString()}`
}

/** `path` with the name `kind`/`id` has to be confirmed with. */
export async function confirmedPath(
  db: Db,
  kind: ConfirmNameKind,
  id: string,
  path: string
): Promise<string> {
  return withConfirmName(path, await confirmNameFor(db, kind, id))
}
