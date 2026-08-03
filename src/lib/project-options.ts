/**
 * Defensive read-only parser for `project.options` jsonb fields used by
 * container naming and optional default server placement. Does not model or
 * round-trip `options.compose`.
 */

import { isPlacementServerId } from './compose/placement.ts'

export type ContainerNamingMode = 'uuid' | 'custom'

export type ProjectOptions = {
  containerNaming?: ContainerNamingMode
  /**
   * Optional default placement server. Environments without their own
   * `server_id` inherit this at deploy / lifecycle / stop time.
   */
  defaultServerId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContainerNamingMode(value: unknown): value is ContainerNamingMode {
  return value === 'uuid' || value === 'custom'
}

/**
 * Parse a containerNaming value from JSON. Returns `{ ok: true, value }` for
 * a valid mode, or `{ ok: false }` for invalid input.
 */
export function parseContainerNamingInput(
  value: unknown,
): { ok: true; value: ContainerNamingMode } | { ok: false } {
  if (!isContainerNamingMode(value)) return { ok: false }
  return { ok: true, value }
}

/**
 * Parse a defaultServerId PATCH/options value.
 * `null` → clear (`{ ok: true, value: null }`). Valid UUID → keep.
 * Invalid → `{ ok: false }`.
 */
export function parseDefaultServerIdInput(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string' || !isPlacementServerId(value)) {
    return { ok: false }
  }
  return { ok: true, value }
}

/** Parse project.options jsonb (missing/invalid keys → omitted). */
export function parseProjectOptions(value: unknown): ProjectOptions {
  if (!isRecord(value)) return {}
  const options: ProjectOptions = {}
  if ('containerNaming' in value) {
    const parsed = parseContainerNamingInput(value.containerNaming)
    if (parsed.ok) options.containerNaming = parsed.value
  }
  if ('defaultServerId' in value) {
    const parsed = parseDefaultServerIdInput(value.defaultServerId)
    if (parsed.ok && parsed.value !== null) {
      options.defaultServerId = parsed.value
    }
  }
  return options
}

/** Default container naming mode when unset. */
export function resolveContainerNaming(
  options: ProjectOptions | null | undefined,
): ContainerNamingMode {
  return options?.containerNaming ?? 'uuid'
}

/** Project-level default placement when set. */
export function resolveDefaultServerId(
  options: ProjectOptions | null | undefined,
): string | null {
  return options?.defaultServerId ?? null
}

/**
 * Effective placement for an environment: its own pin wins; otherwise the
 * project default. Compose never carries placement.
 */
export function resolveEffectivePlacementServerId(
  environmentServerId: string | null | undefined,
  projectOptions: ProjectOptions | null | undefined,
): string | null {
  if (environmentServerId) return environmentServerId
  return resolveDefaultServerId(projectOptions)
}
