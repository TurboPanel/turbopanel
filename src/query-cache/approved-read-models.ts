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
  /** True when the statement carries a version stamp parameter that never filters rows. */
  readonly versionStamp: boolean
}

/** A read whose statement carries the version stamp (see `cached-read.ts`). */
function stamped(fingerprint: string): CachedReadRegistration {
  return {
    fingerprint,
    tolerates: 'an edit shows at once (version stamp); other changes up to 75 seconds late',
    versionStamp: true,
  }
}

export const CACHED_READ_REGISTRY = {
  'servers-list': stamped('ce2766c84e1e7439'),
  'server-detail': stamped('38a4113cda59ba1c'),
  'projects-list': stamped('149aed403aca2c7f'),
  'project-detail': stamped('319d42b70c857a78'),
  'environments-list': stamped('b2bbbde9ee5550e0'),
  'environment-detail': stamped('1cee068d52256e51'),
  'workspaces-list': stamped('abd2761821e1adfd'),
} satisfies Record<string, CachedReadRegistration>

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
