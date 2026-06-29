/** Window after a successful update ack while the daemon may still be restarting. */
export const UPDATE_PENDING_MS = 120_000

/** Default TTL for in-flight update requests before they are treated as expired. */
export const UPDATE_REQUEST_TTL_MS = 300_000

/** How long terminal update request records stay queryable for status polling. */
export const TERMINAL_UPDATE_RETENTION_MS = UPDATE_PENDING_MS

/** Short-lived cache for trunk manifest lookups (matches CDN short-cache). */
export const TRUNK_MANIFEST_CACHE_MS = 30_000
