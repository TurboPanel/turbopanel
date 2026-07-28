/**
 * Defensive read-only parser for `project.options` jsonb fields used by
 * container naming settings. Does not model or round-trip `options.compose`.
 */

export type ContainerNamingMode = 'uuid' | 'custom'

export type ProjectOptions = {
  containerNaming?: ContainerNamingMode
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

/** Parse project.options jsonb (missing/invalid keys → omitted). */
export function parseProjectOptions(value: unknown): ProjectOptions {
  if (!isRecord(value)) return {}
  const options: ProjectOptions = {}
  if ('containerNaming' in value) {
    const parsed = parseContainerNamingInput(value.containerNaming)
    if (parsed.ok) options.containerNaming = parsed.value
  }
  return options
}

/** Default container naming mode when unset. */
export function resolveContainerNaming(
  options: ProjectOptions | null | undefined,
): ContainerNamingMode {
  return options?.containerNaming ?? 'uuid'
}
