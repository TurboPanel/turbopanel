/**
 * Which environments and projects follow which repository.
 *
 * A compose document names a repository at
 * `services.<name>.x-turbopanel.source.sourceId`. A push must find the
 * environments that document reaches without scanning every options column,
 * so the references are kept as `watch` rows: one per (repository, environment)
 * and one per (repository, project). A row for a project fans out to every
 * environment of that project, because the project document is the base every
 * environment overlays.
 *
 * The rows are derived from the options the compose lives in and are brought
 * back in step ({@link syncEnvironmentWatch}, {@link syncProjectWatch}) right
 * after any write of those options.
 */

import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'

/**
 * Compose stores `services.<name>.x-turbopanel.source.sourceId` in jsonb, but a
 * `!override` / `!reset` tag can wrap **any** node on that path as a
 * `{ __turbopanelComposeTag, value }` sentinel (`src/features/compose/tags.ts`) — the
 * scalar id, the whole `source` mapping, `x-turbopanel`, or the service itself.
 * Enumerating those shapes one by one is how tagged mappings were missed, so the
 * lookup uses recursive `**` hops between the anchor keys instead: every
 * intervening `value` wrapper is absorbed, while the match still has to sit on a
 * literal `x-turbopanel` → `source` → `sourceId` chain (a stray `sourceId`
 * elsewhere in the service does not count).
 *
 * Bind the `$sid` variable via `jsonb_build_object('sid', <uuid>::text)`.
 */
export const COMPOSE_SOURCE_JSONPATH =
  '$."compose"."data"."services".**."x-turbopanel".**."source".**."sourceId".**' + ' ? (@ == $sid)'

/**
 * Bring the `watch` rows of one environment in step with the repositories its
 * compose names. Call it in the transaction that wrote the options, with the
 * environment row locked: it removes the rows no longer wanted and adds the
 * missing ones (an existing row is left alone), so two syncs that overlap
 * cannot refuse each other or leave a window with no rows.
 */
export async function syncEnvironmentWatch(db: Db, environmentId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM "watch" w
    WHERE w."environment_id" = ${environmentId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM "environment" e
        JOIN "project" p ON p."id" = e."project_id"
        JOIN "repository" r ON r."id" = w."repository_id" AND r."organization_id" = p."organization_id"
        WHERE e."id" = w."environment_id"
          AND jsonb_path_exists(e."options", ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
            jsonb_build_object('sid', r."id"::text))
      )
  `)
  await db.execute(sql`
    INSERT INTO "watch" ("repository_id", "environment_id")
    SELECT r."id", e."id"
    FROM "environment" e
    JOIN "project" p ON p."id" = e."project_id"
    JOIN "repository" r ON r."organization_id" = p."organization_id"
    WHERE e."id" = ${environmentId}::uuid
      AND jsonb_path_exists(e."options", ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
        jsonb_build_object('sid', r."id"::text))
    ON CONFLICT DO NOTHING
  `)
}

/** Bring the `watch` rows of one project in step with the repositories its compose names (see {@link syncEnvironmentWatch}). */
export async function syncProjectWatch(db: Db, projectId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM "watch" w
    WHERE w."project_id" = ${projectId}::uuid
      AND NOT EXISTS (
        SELECT 1
        FROM "project" p
        JOIN "repository" r ON r."id" = w."repository_id" AND r."organization_id" = p."organization_id"
        WHERE p."id" = w."project_id"
          AND jsonb_path_exists(p."options", ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
            jsonb_build_object('sid', r."id"::text))
      )
  `)
  await db.execute(sql`
    INSERT INTO "watch" ("repository_id", "project_id")
    SELECT r."id", p."id"
    FROM "project" p
    JOIN "repository" r ON r."organization_id" = p."organization_id"
    WHERE p."id" = ${projectId}::uuid
      AND jsonb_path_exists(p."options", ${COMPOSE_SOURCE_JSONPATH}::jsonpath,
        jsonb_build_object('sid', r."id"::text))
    ON CONFLICT DO NOTHING
  `)
}

/** Environments that follow a repository, directly or through their project. */
export async function listWatchingEnvironmentIds(
  db: Db,
  organizationId: string,
  repositoryId: string
): Promise<string[]> {
  const rows = await db.execute<{ environment_id: string }>(sql`
    SELECT e."id" AS environment_id
    FROM "watch" k
    JOIN "environment" e ON e."id" = k."environment_id"
    JOIN "project" p ON p."id" = e."project_id"
    WHERE k."repository_id" = ${repositoryId}::uuid AND p."organization_id" = ${organizationId}::uuid
    UNION
    SELECT e."id" AS environment_id
    FROM "watch" k
    JOIN "project" p ON p."id" = k."project_id"
    JOIN "environment" e ON e."project_id" = p."id"
    WHERE k."repository_id" = ${repositoryId}::uuid AND p."organization_id" = ${organizationId}::uuid
  `)
  return [...new Set(rows.map((row) => row.environment_id))]
}

/** True when any environment or project names the repository in its compose. */
export async function repositoryIsWatched(db: Db, repositoryId: string): Promise<boolean> {
  const rows = await db.execute<{ watched: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM "watch" WHERE "repository_id" = ${repositoryId}::uuid) AS watched`
  )
  return rows[0]?.watched === true
}
