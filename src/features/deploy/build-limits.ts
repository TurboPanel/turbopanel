/**
 * Build resource limits: the most CPU cores and memory one build may use.
 *
 * A limit can be set at three levels: the organization (per build, on any
 * server), the server, and the service. The effective limit of a build is the
 * smallest one set, for cores and for memory on their own. Swap is off unless
 * a level opts in and none says off (off at any level wins); the daemon then
 * caps swap at the build's memory limit. Nothing is stored
 * in new columns: `organization.options.buildLimits`,
 * `server.options.buildLimits` and `service.options.build.{cores,memoryBytes}`.
 *
 * The daemon applies the defaults when nothing is set (half the server's cores,
 * the server's RAM less 1 GiB), caps a limit above the server to the server and
 * words the deploy log; this module only resolves what the levels say and the
 * wire value (`buildLimits`, feature `build-limits-v1`).
 */

import type { BuildLimits, BuildLimitSource } from '../../contracts/commands/schemas.ts'

/** Most cores a level may set (the helper takes 3 digits and 2 decimals). */
export const BUILD_CORES_MAX = 999
/** Fewest cores a level may set. */
export const BUILD_CORES_MIN = 1
/** Smallest memory limit a level may set: 1 GiB. */
export const BUILD_MEMORY_MIN_BYTES = 1024 ** 3
/** Largest memory limit a level may set: 1 TiB. */
export const BUILD_MEMORY_MAX_BYTES = 1024 ** 4

/** One level's settings; an absent part is not set at that level. */
export type BuildLimitSettings = {
  cores?: number
  memoryBytes?: number
  /** Whether a build may use swap; absent is not set. Off at any level wins. */
  swap?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whole hundredths of a core. */
function roundCores(cores: number): number {
  return Math.round(cores * 100) / 100
}

function validCores(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = roundCores(value)
  return rounded >= BUILD_CORES_MIN && rounded <= BUILD_CORES_MAX ? rounded : undefined
}

function validMemory(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= BUILD_MEMORY_MIN_BYTES && value <= BUILD_MEMORY_MAX_BYTES ? value : undefined
}

/** Stored settings: invalid or missing parts are dropped. */
export function parseBuildLimitSettings(value: unknown): BuildLimitSettings {
  if (!isRecord(value)) return {}
  const settings: BuildLimitSettings = {}
  const cores = validCores(value.cores)
  if (cores !== undefined) settings.cores = cores
  const memoryBytes = validMemory(value.memoryBytes)
  if (memoryBytes !== undefined) settings.memoryBytes = memoryBytes
  if (typeof value.swap === 'boolean') settings.swap = value.swap
  return settings
}

/**
 * A request's settings: `null` or a missing part means not set, anything else
 * must be in range. `{}` and `null` clear the level.
 */
export function parseBuildLimitSettingsInput(
  value: unknown
): { ok: true; value: BuildLimitSettings } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: {} }
  if (!isRecord(value)) return { ok: false, error: 'Invalid buildLimits' }
  const settings: BuildLimitSettings = {}
  if (value.cores !== undefined && value.cores !== null) {
    const cores = validCores(value.cores)
    if (cores === undefined) return { ok: false, error: 'Invalid buildLimits cores' }
    settings.cores = cores
  }
  if (value.memoryBytes !== undefined && value.memoryBytes !== null) {
    const memoryBytes = validMemory(value.memoryBytes)
    if (memoryBytes === undefined) return { ok: false, error: 'Invalid buildLimits memoryBytes' }
    settings.memoryBytes = memoryBytes
  }
  if (value.swap !== undefined && value.swap !== null) {
    if (typeof value.swap !== 'boolean') return { ok: false, error: 'Invalid buildLimits swap' }
    settings.swap = value.swap
  }
  return { ok: true, value: settings }
}

/** The settings a service keeps under `service.options.build`. */
export function serviceBuildLimitSettings(build: unknown): BuildLimitSettings {
  return parseBuildLimitSettings(build)
}

/**
 * The effective limits of one build: the smallest set among the levels, each
 * part on its own. A tie goes to the narrowest level (service, then server,
 * then organization). `undefined` when no level sets anything.
 */
export function resolveBuildLimits(levels: {
  organization?: BuildLimitSettings
  server?: BuildLimitSettings
  service?: BuildLimitSettings
}): BuildLimits | undefined {
  const ordered: Array<[BuildLimitSource, BuildLimitSettings | undefined]> = [
    ['service', levels.service],
    ['server', levels.server],
    ['organization', levels.organization],
  ]
  let cores: BuildLimits['cores']
  let memory: BuildLimits['memory']
  let swap: BuildLimits['swap']
  for (const [source, settings] of ordered) {
    // Swap is not a smallest-wins limit: off at any level wins; on only when a
    // level allows it and none says off. The narrowest level that said the
    // winning answer is the source.
    if (settings?.swap === false && swap?.allowed !== false) {
      swap = { allowed: false, source }
    } else if (settings?.swap === true && swap === undefined) {
      swap = { allowed: true, source }
    }
    if (settings?.cores !== undefined && (!cores || settings.cores < cores.cores)) {
      cores = { cores: settings.cores, source }
    }
    if (settings?.memoryBytes !== undefined && (!memory || settings.memoryBytes < memory.bytes)) {
      memory = { bytes: settings.memoryBytes, source }
    }
  }
  if (!cores && !memory && !swap) return undefined
  return {
    ...(cores ? { cores } : {}),
    ...(memory ? { memory } : {}),
    ...(swap ? { swap } : {}),
  }
}

function optionsBuildLimits(options: unknown): BuildLimitSettings {
  return isRecord(options) ? parseBuildLimitSettings(options.buildLimits) : {}
}

/**
 * Give each source entry the full limits of its build: its service's own
 * `options.build`, the server's and the organization's, the smallest of each
 * part. An entry no level limits stays as it is, so the daemon's defaults apply
 * and an unlimited deploy sends nothing new.
 */
export function attachBuildLimits<
  T extends { composeServiceName: string; buildLimits?: BuildLimits },
>(
  entries: readonly T[],
  levels: {
    organizationOptions: unknown
    serverOptions: unknown
    serviceOptionsByComposeName: ReadonlyMap<string, unknown>
  }
): T[] {
  const organization = optionsBuildLimits(levels.organizationOptions)
  const server = optionsBuildLimits(levels.serverOptions)
  return entries.map((entry) => {
    const serviceOptions = levels.serviceOptionsByComposeName.get(entry.composeServiceName)
    const service = isRecord(serviceOptions) ? serviceBuildLimitSettings(serviceOptions.build) : {}
    const buildLimits = resolveBuildLimits({ organization, server, service })
    return buildLimits ? { ...entry, buildLimits } : entry
  })
}
