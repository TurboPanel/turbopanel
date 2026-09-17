/**
 * Postgres unique-violation detection that survives error wrapping.
 *
 * drizzle-orm 0.45 (f68a4ee8's osv-scanner bump) throws `DrizzleQueryError`
 * from every query: its `.message` is "Failed query: …" and the real
 * postgres.js error — `code` `23505`, and the `duplicate key value violates
 * unique constraint "…"` message that names the index — sits on `.cause`.
 * Every route that mapped a duplicate to a 409 by reading the top-level
 * `code`/`message` silently became a 500 at that bump; CI never saw it
 * because no Build ran to completion between that commit and the Database
 * batch. One helper here, walked from the thrown error down its `.cause`
 * chain, so the check cannot drift per file again.
 */

const PG_UNIQUE_VIOLATION = "23505";
const MAX_CAUSE_DEPTH = 4;

function* causeChain(err: unknown): Generator<unknown> {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return;
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/** SQLSTATE 23505 on the error or any `.cause` beneath it. */
export function isPostgresUniqueViolation(err: unknown): boolean {
  for (const layer of causeChain(err)) {
    if ((layer as { code?: unknown }).code === PG_UNIQUE_VIOLATION) return true;
  }
  return false;
}

/**
 * The unique-violation layer's own message (the one naming the constraint),
 * or null when `err` is not a unique violation.
 */
export function uniqueViolationMessage(err: unknown): string | null {
  for (const layer of causeChain(err)) {
    if ((layer as { code?: unknown }).code !== PG_UNIQUE_VIOLATION) continue;
    const message = (layer as { message?: unknown }).message;
    return typeof message === "string" ? message : String(message ?? "");
  }
  return null;
}

/** A unique violation whose message names `constraintName`. */
export function isUniqueViolationOn(err: unknown, constraintName: string): boolean {
  return uniqueViolationMessage(err)?.includes(constraintName) ?? false;
}
