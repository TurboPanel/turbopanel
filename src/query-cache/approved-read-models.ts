/**
 * Allowlist of read models permitted to use the cached database connection.
 * Add new entries only after security review — loaders must be read-only SELECTs.
 */
export const APPROVED_READ_MODELS = ['servers-list'] as const

export type ApprovedReadModelId = (typeof APPROVED_READ_MODELS)[number]

export function isApprovedReadModelId(value: string): value is ApprovedReadModelId {
  return (APPROVED_READ_MODELS as readonly string[]).includes(value)
}
