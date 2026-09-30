/**
 * One log-safe line for a thrown value, including the error it wraps.
 *
 * Drizzle wraps every driver failure in `DrizzleQueryError`, whose message is
 * only "Failed query: <sql> params: <values>". The actual Postgres error
 * (`permission denied for table setting`, `relation "setting" does not
 * exist`, a refused connection) sits in `err.cause`, and `String(err)` drops
 * it. {@link describeError} keeps `String(err)` as the first line and adds one
 * `caused by:` line per wrapped error.
 *
 * Each cause contributes its name, message, `code` (the SQLSTATE for a
 * Postgres error) and `severity` only. Everything else a driver error carries
 * stays out of the log: postgres.js attaches the query's bind `parameters`,
 * and a Postgres `detail` can echo row values (`Key (email)=(...) already
 * exists`). A password inside a URL (`postgres://user:secret@host`) is masked.
 */

/** Same cap as `isConnectionClosedError` in `src/db/connection.ts`. */
const MAX_CAUSE_DEPTH = 4

/** `scheme://user:password@` — the password part is masked. */
const URL_PASSWORD = /([a-z][a-z\d+.-]*:\/\/[^\s/:@]*):[^\s/@]*@/gi

function maskUrlPasswords(text: string): string {
  return text.replaceAll(URL_PASSWORD, '$1:***@')
}

function readString(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && field !== '' ? field : undefined
}

/** `(code 42501, severity ERROR)`, or '' when the error carries neither. */
function codeSuffix(value: object): string {
  const parts: string[] = []
  const code = readString(value, 'code')
  if (code) parts.push(`code ${code}`)
  const severity = readString(value, 'severity')
  if (severity) parts.push(`severity ${severity}`)
  return parts.length > 0 ? ` (${parts.join(', ')})` : ''
}

function describeCause(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return String(cause)
  const name = readString(cause, 'name') ?? 'Error'
  const message = readString(cause, 'message') ?? '(no message)'
  return `${name}: ${message}${codeSuffix(cause)}`
}

function readCause(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as { cause?: unknown }).cause
}

/**
 * The `caused by:` lines for `err`'s cause chain (up to four levels), or ''
 * when it wraps nothing.
 */
export function describeErrorCauses(err: unknown): string {
  const lines: string[] = []
  const seen = new Set<unknown>([err])
  let cause = readCause(err)
  while (
    cause !== undefined &&
    cause !== null &&
    !seen.has(cause) &&
    lines.length < MAX_CAUSE_DEPTH
  ) {
    seen.add(cause)
    lines.push(`caused by: ${describeCause(cause)}`)
    cause = readCause(cause)
  }
  return maskUrlPasswords(lines.join('\n'))
}

/**
 * `String(err)` plus its code and cause chain. A plain error with no code and
 * no cause reads exactly as `String(err)` did.
 */
export function describeError(err: unknown): string {
  const suffix = err instanceof Error ? codeSuffix(err) : ''
  const head = maskUrlPasswords(String(err) + suffix)
  const causes = describeErrorCauses(err)
  return causes === '' ? head : `${head}\n${causes}`
}
