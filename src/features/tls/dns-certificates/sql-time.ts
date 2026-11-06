import { type SQL, sql } from 'drizzle-orm'

/**
 * A text value read as a time, or the epoch when it is missing or not a time,
 * so one bad value in metadata never fails a whole query.
 */
export function safeTimestamp(text: SQL): SQL {
  return sql`(case when pg_input_is_valid(${text}, 'timestamptz') then (${text})::timestamptz else 'epoch'::timestamptz end)`
}
