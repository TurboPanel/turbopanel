/**
 * Checked vocabularies for the `record` table (DNS records TurboPanel manages
 * at a connected provider). The `CHECK` lists in `src/db/schema.ts` are pinned
 * to these arrays by `src/db/enum-checks.test.ts`. Add a member in both places.
 */

/** Record types TurboPanel writes. */
export const RECORD_KINDS = ['A', 'AAAA', 'CNAME'] as const

export type RecordKind = (typeof RECORD_KINDS)[number]

/** Where a managed record stands after the last drift check. */
export const RECORD_STATUSES = ['pending', 'synced', 'drifted', 'removing', 'failed'] as const

export type RecordStatus = (typeof RECORD_STATUSES)[number]

/** Providers that can hold a managed record. */
export const RECORD_PROVIDERS = ['cloudflare'] as const

export type RecordProvider = (typeof RECORD_PROVIDERS)[number]
