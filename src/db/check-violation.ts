/**
 * Postgres check-violation detection that survives error wrapping, the way
 * `unique-violation.ts` does for 23505: drizzle throws `DrizzleQueryError`
 * whose `.message` is "Failed query: …" and the postgres.js error (`code`
 * `23514`, `constraint_name`, and a message naming the constraint) sits on
 * `.cause`.
 */

const PG_CHECK_VIOLATION = '23514'
const MAX_CAUSE_DEPTH = 4

/** SQLSTATE 23514 on the error or any `.cause` beneath it, naming `constraintName`. */
export function isCheckViolationOn(err: unknown, constraintName: string): boolean {
  let current: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    const layer = current as { code?: unknown; constraint_name?: unknown; message?: unknown }
    if (layer.code === PG_CHECK_VIOLATION) {
      if (layer.constraint_name === constraintName) return true
      if (typeof layer.message === 'string' && layer.message.includes(constraintName)) return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}
