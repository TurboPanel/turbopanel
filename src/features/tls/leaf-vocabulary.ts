/**
 * Words and limits for the Organization CA leaf tracking rows that need an
 * owner's attention (`leaf.state`, `leaf.stale_reason`, `leaf.last_error`).
 * `schema.ts` carries the same lists as CHECK constraints; `enum-checks.test.ts`
 * pins them together.
 */

/** `active` leaves are counted and renewed; `stale` ones wait on nothing. */
export const LEAF_STATES = ['active', 'stale'] as const

export type LeafState = (typeof LEAF_STATES)[number]

/** A server offline longer than this stops holding back renewals (days). */
export const LEAF_STALE_OFFLINE_DAYS = 14

/** After the last target converges the previous CA is retired by itself this many days later. */
export const CA_RETIRE_GRACE_DAYS = 30

/** The CHECK on `leaf.stale_reason` / `leaf.last_error`. */
export const LEAF_TEXT_MAX = 300

const MS_PER_DAY = 86_400_000

export const LEAF_STALE_NOT_NEEDED = 'Nothing on this server uses this certificate any more.'

export const LEAF_STALE_BY_OWNER = 'Marked stale by an owner.'

/** Shorten free text so it fits the column CHECK. */
export function clipLeafText(text: string): string {
  const trimmed = text.trim().replaceAll(/\s+/g, ' ')
  if (trimmed.length <= LEAF_TEXT_MAX) return trimmed
  return `${trimmed.slice(0, LEAF_TEXT_MAX - 1)}…`
}

export function leafStaleOfflineReason(offlineSinceIso: string | null): string {
  if (!offlineSinceIso) return 'The server has been offline for a long time.'
  return `The server has been offline since ${offlineSinceIso.slice(0, 10)}.`
}

/** True when a server has been disconnected for at least {@link LEAF_STALE_OFFLINE_DAYS}. */
export function serverOfflineTooLong(params: {
  isConnected: boolean
  statusChangedAt: string | null
  nowMs?: number
}): boolean {
  if (params.isConnected) return false
  if (!params.statusChangedAt) return false
  const changed = Date.parse(params.statusChangedAt)
  if (!Number.isFinite(changed)) return false
  const nowMs = params.nowMs ?? Date.now()
  return nowMs - changed >= LEAF_STALE_OFFLINE_DAYS * MS_PER_DAY
}

/** Deadline written when fan-out finishes. */
export function caRetireByIso(nowMs = Date.now()): string {
  return new Date(nowMs + CA_RETIRE_GRACE_DAYS * MS_PER_DAY).toISOString()
}
