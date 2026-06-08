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
}
