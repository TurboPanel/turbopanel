/**
 * Principal-alias helpers shared by the compose write boundary.
 *
 * Sibling of `./repository-records.ts` and deliberately shaped like it: one
 * **pure** reader over an options blob, one DB loader for the layer a caller
 * cannot see from the request body. Compose validation is pure and cannot reach
 * the database, so the project / environment create + PATCH routes assemble the
 * alias set once per request and hand it to `lintComposeYaml` as
 * `knownPrincipalAliases` — exactly the arrangement `knownSourceIds` already
 * uses.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { principalAliasesInComposeData } from '../compose/index.ts'
import { project } from './schema.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Aliases declared by the root `x-turbopanel.principals` of the compose
 * document inside an options blob.
 *
 * Reads the same normalized root extension the deploy path does rather than
 * poking at raw keys, so an entry the parser would drop as unusable is not
 * counted as declared here either.
 */
export function composePrincipalAliases(options: unknown): Set<string> {
  if (!isPlainObject(options)) return new Set()
  const compose = options.compose
  if (!isPlainObject(compose)) return new Set()
  return principalAliasesInComposeData(compose.data)
}

/**
 * Aliases the **project's persisted base** declares.
 *
 * An overlay is part of its project's compose, so a service in an environment
 * document may name an alias the project root declared — the same "an overlay
 * answers to the project's rule" shape `loadProjectRepositoryId` exists for.
 * An unknown project yields an empty set rather than throwing: the caller has
 * already resolved (or refused) the project by the time it asks.
 */
export async function loadProjectPrincipalAliases(
  db: Db,
  projectId: string,
): Promise<Set<string>> {
  const [row] = await db
    .select({ options: project.options })
    .from(project)
    .where(eq(project.id, projectId))
    .limit(1)
  return composePrincipalAliases(row?.options)
}

/** Union of two alias sets, for the overlay case (project base ∪ own root). */
export function unionAliasSets(
  ...sets: ReadonlyArray<ReadonlySet<string>>
): Set<string> {
  const out = new Set<string>()
  for (const set of sets) {
    for (const alias of set) out.add(alias)
  }
  return out
}
