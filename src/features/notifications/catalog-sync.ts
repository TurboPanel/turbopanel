/**
 * Write the notification catalog (`category`, `topic`) from the code in
 * `events.ts`. Run by `pnpm migrate` (`scripts/migrate-locked.mjs`) and
 * `turbopanel migrate` (`src/cli/migrate.ts`) after the migrations, and once
 * per process before the first write that names a topic, so a database brought
 * up any other way still has the rows its foreign keys need.
 *
 * Upserts by code and never deletes: preferences and history keep naming a
 * code that left the code base, which is stamped `deprecated_at` instead (and
 * cleared again if the code comes back).
 *
 * Plain SQL over a caller-supplied runner, so the Node migrate script, the
 * Deno CLI and drizzle can all use it. No imports beyond the catalogue.
 */
import { notificationCatalogRows } from './events.ts'

/** Runs one parameterised statement; `$1`-style placeholders. */
export type CatalogSqlRunner = (text: string, params: unknown[]) => Promise<unknown>

export const UPSERT_CATEGORIES_SQL = `INSERT INTO "category" ("code", "name", "position")
SELECT x.code, x.name, x.position
FROM jsonb_to_recordset($1::jsonb) AS x(code text, name text, position integer)
ON CONFLICT ("code") DO UPDATE SET
  "name" = excluded."name",
  "position" = excluded."position",
  "updated_at" = now()
WHERE ("category"."name", "category"."position") IS DISTINCT FROM (excluded."name", excluded."position")`

export const UPSERT_TOPICS_SQL = `INSERT INTO "topic" ("code", "category_code", "name", "kind", "severity", "scope", "audience", "channels", "is_urgent", "deprecated_at")
SELECT x.code, x.category_code, x.name, x.kind, x.severity, x.scope, x.audience,
  ARRAY(SELECT jsonb_array_elements_text(x.channels)), x.is_urgent, NULL
FROM jsonb_to_recordset($1::jsonb) AS x(code text, category_code text, name text, kind text,
  severity text, scope text, audience text, channels jsonb, is_urgent boolean)
ON CONFLICT ("code") DO UPDATE SET
  "category_code" = excluded."category_code",
  "name" = excluded."name",
  "kind" = excluded."kind",
  "severity" = excluded."severity",
  "scope" = excluded."scope",
  "audience" = excluded."audience",
  "channels" = excluded."channels",
  "is_urgent" = excluded."is_urgent",
  "deprecated_at" = NULL,
  "updated_at" = now()
WHERE ("topic"."category_code", "topic"."name", "topic"."kind", "topic"."severity", "topic"."scope",
  "topic"."audience", "topic"."channels", "topic"."is_urgent", "topic"."deprecated_at")
  IS DISTINCT FROM (excluded."category_code", excluded."name", excluded."kind", excluded."severity",
  excluded."scope", excluded."audience", excluded."channels", excluded."is_urgent", NULL::timestamptz)`

export const DEPRECATE_TOPICS_SQL = `UPDATE "topic" SET "deprecated_at" = now(), "updated_at" = now()
WHERE "deprecated_at" IS NULL
  AND "code" NOT IN (SELECT jsonb_array_elements_text($1::jsonb))`

/** Bring `category` and `topic` in line with this build. Throws on a database error. */
export async function syncNotificationCatalog(run: CatalogSqlRunner): Promise<void> {
  const { categories, topics } = notificationCatalogRows()
  await run(UPSERT_CATEGORIES_SQL, [JSON.stringify(categories)])
  await run(UPSERT_TOPICS_SQL, [JSON.stringify(topics)])
  // Every list goes in as one JSON text parameter: a driver may expand a
  // JavaScript array into a row of parameters, which no cast turns back.
  await run(DEPRECATE_TOPICS_SQL, [JSON.stringify(topics.map((t) => t.code))])
}
