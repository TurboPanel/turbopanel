/** Read the Docker network name from a `network` row (`kind = docker`). */

const DOCKER_NETWORK_NAME_KEY = 'dockerNetworkName'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
