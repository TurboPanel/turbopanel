import { type SQL, sql } from 'drizzle-orm'

/**
 * Read a list of names a subquery returned. The Workers database client does
 * not look up array column types (`fetch_types: false`), so a Postgres array
 * would reach the code as the text `{a,b}` instead of a list. The subquery
 * therefore asks for JSON text, and this reads it back; a list that is
 * already a list passes through.
 */
export function readNameList(value: unknown): string[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== 'string')) {
    throw new Error('Expected a list of names from the database')
  }
  return parsed as string[]
}

/** Wrap an `ARRAY(SELECT ...)` of names so it reads back as a `string[]` on every client. */
export function nameListSql(arraySubquery: SQL): SQL<string[]> {
  return sql`to_json(${arraySubquery})::text`.mapWith(readNameList) as SQL<string[]>
}
