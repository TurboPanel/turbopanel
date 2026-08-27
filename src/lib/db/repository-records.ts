/**
 * `repository` row helpers shared by the compose write boundary and the sources
 * CRUD routes.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { repository } from './schema.ts'

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
