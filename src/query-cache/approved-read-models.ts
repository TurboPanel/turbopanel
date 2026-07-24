/**
 * Allowlist of read models permitted to use the cached database connection.
 * Add new entries only after security review — loaders must be read-only SELECTs.
 *
 * Audit (complete + minimal): every loader under `read-models/` was reviewed.
 * `servers-list` and `server-detail` qualify — both are auth-agnostic after
 * visibility/org checks on the primary connection, and their cached statements
 * are non-volatile parameterized SELECTs with no session/secret/`daemon`
 * columns. Presence enrichment stays on the primary connection.
 */
export const APPROVED_READ_MODELS = ['servers-list', 'server-detail'] as const

export type ApprovedReadModelId = (typeof APPROVED_READ_MODELS)[number]

export function isApprovedReadModelId(value: string): value is ApprovedReadModelId {
  return (APPROVED_READ_MODELS as readonly string[]).includes(value)
}
