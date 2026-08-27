/**
 * `repository` row helpers shared by the compose write boundary and the sources
 * CRUD routes.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { readServiceSourceExtension } from '../compose/index.ts'
import { environment, project, repository } from './schema.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every `repository.id` owned by an organization.
 *
 * Compose validation is pure and cannot reach the database, so project /
 * environment create + PATCH load this set once per request and hand it to
 * `lintComposeYaml` as `knownSourceIds`.
 */
export async function loadOrganizationRepositoryIds(
  db: Db,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: repository.id })
    .from(repository)
    .where(eq(repository.organizationId, organizationId))
  return new Set(rows.map((row) => row.id))
}

/**
 * The repository a project is bound to, or `null` when it has none yet.
 *
 * Returns `undefined` when the project does not exist, so a caller can tell
 * "unbound" apart from "no such project" without a second query.
 */
export async function loadProjectRepositoryId(
  db: Db,
  projectId: string,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ repositoryId: project.repositoryId })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1)
  return row?.repositoryId
}

/**
 * Distinct `x-turbopanel.source.sourceId` values in a compose options blob, in
 * stable service-key order.
 *
 * Reads the same normalized extension the deploy path does rather than poking
 * at raw keys, so a binding the parser would drop as unusable is not counted as
 * a repository here either.
 */
export function composeSourceIds(
  options: Record<string, unknown> | null | undefined,
): string[] {
  const compose = options?.compose
  if (!isPlainObject(compose)) return []
  const data = compose.data
  if (!isPlainObject(data)) return []
  const services = data.services
  if (!isPlainObject(services)) return []
  const seen = new Set<string>()
  for (const name of Object.keys(services).toSorted((a, b) => a.localeCompare(b))) {
    const raw = services[name]
    if (!isPlainObject(raw)) continue
    const binding = readServiceSourceExtension(raw)
    if (binding) seen.add(binding.sourceId)
  }
  return [...seen]
}

/**
 * Bind a project to the repository its compose names, if it has none yet.
 *
 * **Adoption, not inference.** The single-repository lint rule has already run
 * by the time this is called, so the compose names at most one repository that
 * is not already the project's — which makes "the first id in the document" a
 * decision the operator made, not a guess. Doing it here rather than asking
 * every client to send `repositoryId` is what lets the create wizard seed a
 * draft and write the project in one act.
 *
 * A project that is already bound is left alone: re-binding is a deliberate act
 * (`PATCH /projects/:id` with an explicit `repositoryId`), not something a
 * compose save should do behind the operator's back.
 */
export async function adoptProjectRepository(
  db: Db,
  projectId: string,
  options: Record<string, unknown> | null | undefined,
  current: string | null | undefined,
): Promise<void> {
  if (current) return
  const [adopted] = composeSourceIds(options)
  if (!adopted) return
  await db
    .update(project)
    .set({ repositoryId: adopted })
    .where(and(eq(project.id, projectId), isNull(project.repositoryId)))
}

/**
 * The project an environment belongs to, plus that project's repository.
 *
 * One join rather than two round trips: the environment write boundary needs
 * both — the repository to lint the overlay against, and the project id to
 * adopt onto when there is none yet.
 */
export async function loadEnvironmentProjectRepository(
  db: Db,
  environmentId: string,
): Promise<{ projectId: string; repositoryId: string | null } | undefined> {
  const [row] = await db
    .select({
      projectId: environment.projectId,
      repositoryId: project.repositoryId,
    })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(eq(environment.id, environmentId))
    .limit(1)
  return row
}
