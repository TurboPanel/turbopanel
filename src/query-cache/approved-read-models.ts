/**
 * Allowlist of read models permitted to use the cached database connection.
 * Add new entries only after security review — loaders must be read-only SELECTs.
 *
 * Audit (complete + minimal): every loader under `read-models/` was reviewed.
 * Only `servers-list` qualifies today — it is auth-agnostic after `listVisible`
 * on the primary connection, and its cached statement is a non-volatile
 * parameterized SELECT with no session/secret columns. No other server read is
 * both auth-agnostic and non-volatile enough to allowlist; no loader leaks an
 * uncacheable or auth-sensitive statement onto the cached connection.
 */
export const APPROVED_READ_MODELS = ['servers-list'] as const

export type ApprovedReadModelId = (typeof APPROVED_READ_MODELS)[number]

export function isApprovedReadModelId(value: string): value is ApprovedReadModelId {
  return (APPROVED_READ_MODELS as readonly string[]).includes(value)
}
