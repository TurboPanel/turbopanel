/** Read / validate the Docker network name from a `network` row (`kind = docker`). */

const DOCKER_NETWORK_NAME_KEY = 'dockerNetworkName'

/** Docker Engine network name allowlist (compose `name:` / host `docker network`). */
export const DOCKER_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isValidDockerNetworkName(value: string): boolean {
  return DOCKER_NETWORK_NAME_RE.test(value)
}

export function readNetworkDockerNetworkName(
  options: unknown,
  metadata: unknown,
): string | null {
  if (isRecord(options)) {
    const raw = options[DOCKER_NETWORK_NAME_KEY]
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  if (isRecord(metadata)) {
    const raw = metadata[DOCKER_NETWORK_NAME_KEY]
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.length > 0) return trimmed
    }
  }
  return null
}

export function buildNetworkDockerOptions(dockerNetworkName: string): Record<string, string> {
  return { [DOCKER_NETWORK_NAME_KEY]: dockerNetworkName.trim() }
}

/**
 * Normalize `options` for a `kind: docker` network row.
 * Returns null when `options.dockerNetworkName` is missing or invalid.
 */
export function normalizeDockerNetworkOptions(
  options: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const name = readNetworkDockerNetworkName(options ?? null, null)
  if (!name || !isValidDockerNetworkName(name)) return null
  const normalized = buildNetworkDockerOptions(name)
  if (!options) return normalized
  return { ...options, ...normalized }
}
