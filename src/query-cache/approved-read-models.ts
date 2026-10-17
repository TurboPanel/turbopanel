/**
 * Registry of the read models permitted to use the cached database connection.
 *
 * Each entry pins the fingerprint of the one reviewed statement the read model
 * may send (see `statementFingerprint`). Changing a statement changes its
 * fingerprint, so the registry test fails until the new text is reviewed and
 * the fingerprint here is updated on purpose.
 *
 * Add new entries only after review: the statement must be a read-only SELECT
 * with no volatile function, and the screen must tolerate a 75 second old copy
 * (60 second cache plus 15 seconds of serving stale).
 */
export type CachedReadRegistration = {
  /** Fingerprint of the single reviewed statement. */
  readonly fingerprint: string
  /** What the screen accepts, in plain words. */
  readonly tolerates: string
}

export const CACHED_READ_REGISTRY = {
  'servers-list': {
    fingerprint: '37d1ad25c14196c4',
    tolerates: 'up to 75 seconds old; presence and permissions are read live',
  },
  'server-detail': {
    fingerprint: 'dde4d8f3b9ec6a45',
    tolerates: 'up to 75 seconds old; presence and permissions are read live',
  },
} as const satisfies Record<string, CachedReadRegistration>

export type ApprovedReadModelId = keyof typeof CACHED_READ_REGISTRY

export const APPROVED_READ_MODELS = Object.keys(CACHED_READ_REGISTRY) as ApprovedReadModelId[]

export function isApprovedReadModelId(value: string): value is ApprovedReadModelId {
  return Object.hasOwn(CACHED_READ_REGISTRY, value)
}

const REGISTERED_FINGERPRINTS = new Set<string>(
  Object.values(CACHED_READ_REGISTRY).map((entry) => entry.fingerprint)
)

export function isRegisteredFingerprint(fingerprint: string): boolean {
  return REGISTERED_FINGERPRINTS.has(fingerprint)
}
