import type { ServerGeo } from '../geo/server-geo.ts'

/** OS families we may report from the daemon; extend the union as support is added. */
export type ServerOsFamily = 'linux' | 'windows' | 'freebsd' | 'darwin'

/** Best-effort OS block; fields may be filled in over time. */
export type ServerOsMetadata = {
  family?: ServerOsFamily
  /** e.g. kernel or OS version string */
  version?: string
  /** e.g. arm64, x86_64 */
  arch?: string
}

/**
 * Hybrid / P+E style core counts (optional; omit on homogeneous or unknown CPUs).
 * `p` = performance cores, `e` = efficiency cores.
 */
export type ServerCpuCores = {
  p?: number
  e?: number
}

export type ServerCpuMetadata = {
  sockets?: number
  cores?: ServerCpuCores
  threads?: number
}

/**
 * JSON stored in `server.metadata`. Nested fields are optional; daemon registration
 * also stores `machineId` and `hostname` here for reconnect deduplication.
 */
export type ServerMetadata = {
  os?: ServerOsMetadata
  cpu?: ServerCpuMetadata
  machineId?: string
  hostname?: string
  /**
   * Cloudflare `locationHint` chosen at enrollment time (e.g. `"wnam"`, `"eeur"`).
   * Enrollment-time decision; region moves require a new generation.
   */
  cellLocationHint?: string
  /** Monotonically increasing; increment when a new DO logical name is issued after a region move. */
  cellGeneration?: number
  /** Last snapshot version written by the cell, for optimistic concurrency checks. */
  cellSnapshotVersion?: number
  /**
   * IP geolocation captured from the connecting request (Cloudflare `request.cf`
   * on Workers; stub/null on self-hosted). Refreshed only when the daemon's
   * connecting IP changes. Stored in jsonb — no migration required.
   */
  geo?: ServerGeo
}

/**
 * JSON stored in `server.options`. Operator-controlled server configuration;
 * cell fields here override the enrollment copies in `server.metadata` when both
 * are present.
 */
export type ServerOptions = {
  /**
   * Cloudflare `locationHint` for the daemon cell (e.g. `"wnam"`, `"eeur"`).
   * Takes precedence over `server.metadata.cellLocationHint` when set.
   */
  cellLocationHint?: string
  /**
   * Monotonically increasing cell generation for logical DO naming.
   * Takes precedence over `server.metadata.cellGeneration` when set.
   */
  cellGeneration?: number
}
