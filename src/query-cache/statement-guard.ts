import { createHash } from 'node:crypto'

/**
 * Statement checks for the cached database connection.
 *
 * Hyperdrive caches by statement text plus parameter values, and it matches
 * the text as written (comments and string literals included). So the checks
 * here look at the raw text, and a statement is refused when any doubt is left.
 */

/** Thrown before a statement is sent when it must not use the cached connection. */
export class UncacheableStatementError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`Statement is not allowed on the cached database connection: ${reason}`)
    this.name = 'UncacheableStatementError'
    this.reason = reason
  }
}

/** Functions and keywords whose answer changes between calls. Matched anywhere in the text. */
const VOLATILE_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
  ['now()', /\bnow\s*\(/i],
  ['random()', /\brandom\s*\(/i],
  ['nextval()', /\bnextval\s*\(/i],
  ['currval()', /\bcurrval\s*\(/i],
  ['lastval()', /\blastval\s*\(/i],
  ['uuidv7()', /\buuidv7\s*\(/i],
  ['gen_random_uuid()', /\bgen_random_uuid\s*\(/i],
  ['clock_timestamp()', /\bclock_timestamp\s*\(/i],
  ['statement_timestamp()', /\bstatement_timestamp\s*\(/i],
  ['transaction_timestamp()', /\btransaction_timestamp\s*\(/i],
  ['timeofday()', /\btimeofday\s*\(/i],
  ['current_timestamp', /\bcurrent_timestamp\b/i],
  ['current_date', /\bcurrent_date\b/i],
  ['current_time', /\bcurrent_time\b/i],
  ['localtime', /\blocaltime(stamp)?\b/i],
  ['set_config', /\bset_config\b/i],
  ['pg_sleep', /\bpg_sleep/i],
  ['txid_current', /\btxid_current/i],
  ['pg_advisory', /\bpg_(try_)?advisory/i],
  ['current_user', /\b(current|session)_user\b/i],
  ['current_schema', /\bcurrent_(schema|catalog|role)\b/i],
  ['current_setting', /\bcurrent_setting\b/i],
  ['pg_backend_pid', /\bpg_backend_pid/i],
  ['pg_notify', /\bpg_notify/i],
  ['setseed', /\bsetseed\b/i],
  ['uuidv4()', /\buuidv4\s*\(/i],
  ['a time word cast from text', /'\s*(now|today|tomorrow|yesterday)\s*'/i],
]

/** The statement text with string literals and quoted identifiers blanked out. */
function stripQuoted(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""')
}

/** Reason the statement cannot use the cached connection, or `null` when it can. */
export function uncacheableReason(text: string): string | null {
  if (!/^\s*select\b/i.test(text)) return 'not a SELECT'
  // The cache matches the text as written, and comments or alternative quoting
  // can hide a second statement from a quote-stripping check, so none is allowed.
  if (/--|\/\*|\$\$|\be'/i.test(text)) return 'comment or alternative quoting'
  const bare = stripQuoted(text)
  if (/;\s*\S/.test(bare)) return 'more than one statement'
  if (/\bfor\s+(no\s+key\s+update|update|key\s+share|share)\b/i.test(bare)) {
    return 'row locking clause'
  }
  if (/\binto\b/i.test(bare)) return 'SELECT INTO'
  for (const [name, pattern] of VOLATILE_TOKENS) {
    if (pattern.test(text)) return `uses ${name}`
  }
  return null
}

export function isCacheableStatement(text: string): boolean {
  return uncacheableReason(text) === null
}

/**
 * Canonical form used for fingerprints: whitespace collapsed, every `IN (...)`
 * parameter list reduced to one placeholder (so the list length does not change
 * the fingerprint), and the remaining parameters renumbered in order.
 */
export function normaliseStatement(text: string): string {
  let n = 0
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bin \(\s*\$\d+(?:\s*,\s*\$\d+)*\s*\)/gi, 'in ($*)')
    .replace(/\$\d+/g, () => `$${++n}`)
}

/** Short stable hash of the normalised statement text. */
export function statementFingerprint(text: string): string {
  return createHash('sha256').update(normaliseStatement(text)).digest('hex').slice(0, 16)
}

/** Hash of a statement plus its parameter values: what a cache key is made from. */
export function statementKeyHash(text: string, params: readonly unknown[]): string {
  return createHash('sha256')
    .update(text)
    .update('\u0000')
    .update(JSON.stringify(params))
    .digest('hex')
    .slice(0, 32)
}

/** The guard's error itself, or the one a query driver wrapped as its `cause`. */
export function findUncacheableStatementError(err: unknown): UncacheableStatementError | null {
  let current: unknown = err
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current instanceof UncacheableStatementError) return current
    current = (current as { cause?: unknown }).cause
  }
  return null
}
