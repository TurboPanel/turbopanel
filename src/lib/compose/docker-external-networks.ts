/**
 * Collect Docker network names referenced as `external: true` in compose YAML.
 * Uses the Compose `name:` override when present, otherwise the mapping key.
 */

import { parse } from 'yaml'

const DOCKER_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readExternalNetworkName(
  key: string,
  value: unknown,
): string | null {
  if (!isRecord(value)) return null
  if (value.external !== true) return null
  const explicit = value.name
  if (typeof explicit === 'string') {
    const trimmed = explicit.trim()
    if (trimmed.length > 0 && DOCKER_NETWORK_NAME_RE.test(trimmed)) return trimmed
    return null
  }
  if (DOCKER_NETWORK_NAME_RE.test(key)) return key
  return null
}

/** Sorted unique external Docker network names declared in top-level `networks:`. */
export function collectComposeExternalDockerNetworkNames(composeYaml: string): string[] {
  if (composeYaml.trim().length === 0) return []

  const parsed: unknown = parse(composeYaml)
  if (!isRecord(parsed) || !isRecord(parsed.networks)) return []

  const names = new Set<string>()
  for (const [key, entry] of Object.entries(parsed.networks)) {
    const name = readExternalNetworkName(key, entry)
    if (name) names.add(name)
  }

  return [...names].sort((a, b) => a.localeCompare(b))
}
