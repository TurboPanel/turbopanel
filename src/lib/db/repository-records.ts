/**
 * `source` row helpers shared by the compose write boundary and the sources
 * CRUD routes.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { source } from './schema.ts'

/**
 * Every `source.id` owned by an organization.
 *
 * Compose validation is pure and cannot reach the database, so project /
 * environment create + PATCH load this set once per request and hand it to
 * `lintComposeYaml` as `knownSourceIds`.
 */
export async function loadOrganizationSourceIds(
  db: Db,
  organizationId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: source.id })
    .from(source)
    .where(eq(source.organizationId, organizationId))
  return new Set(rows.map((row) => row.id))
}
