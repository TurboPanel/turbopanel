/**
 * Collect Docker network names referenced as external in compose YAML, and
 * prune top-level networks no remaining container service references.
 *
 * Supports Compose Spec forms:
 * - `external: true` (+ optional sibling `name:`)
 * - `external: { name: "…" }`
 * - `external: {}` (uses the mapping key)
 */

import { parse } from 'yaml'
import { isValidDockerNetworkName } from '../docker-network-name.ts'
import { COMPOSE_YAML_OPTIONS } from './tags.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readValidNetworkName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0 || !isValidDockerNetworkName(trimmed)) return null
  return trimmed
}

/**
 * Resolve the host Docker network name for one top-level `networks:` entry.
 * Returns null when the entry is not external (project-internal networks).
 */
export function readComposeExternalDockerNetworkName(
  key: string,
  value: unknown,
): string | null {
  if (!isRecord(value)) return null

  const external = value.external
  if (external === true) {
    const explicit = readValidNetworkName(value.name)
    if (explicit) return explicit
    return isValidDockerNetworkName(key) ? key : null
  }

  if (!isRecord(external)) return null

  // Compose Spec object form: `external: { name: "…" }` or `external: {}`.
  const nested = readValidNetworkName(external.name)
  if (nested) return nested
  const sibling = readValidNetworkName(value.name)
  if (sibling) return sibling
  return isValidDockerNetworkName(key) ? key : null
}

/** Sorted unique external Docker network names declared in top-level `networks:`. */
export function collectComposeExternalDockerNetworkNames(composeYaml: string): string[] {
  if (composeYaml.trim().length === 0) return []

  const parsed: unknown = parse(composeYaml, COMPOSE_YAML_OPTIONS)
  if (!isRecord(parsed) || !isRecord(parsed.networks)) return []

  const names = new Set<string>()
  for (const [key, entry] of Object.entries(parsed.networks)) {
    const name = readComposeExternalDockerNetworkName(key, entry)
    if (name) names.add(name)
  }

  return [...names].sort((a, b) => a.localeCompare(b))
}

function collectNetworkKeysFromList(networks: unknown[]): string[] {
  const keys: string[] = []
  for (const entry of networks) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim()
      if (trimmed.length > 0) keys.push(trimmed)
      continue
    }
    if (isRecord(entry)) {
      for (const key of Object.keys(entry)) {
        if (key.trim().length > 0) keys.push(key)
      }
    }
  }
  return keys
}

/** Mapping keys from a service's `networks:` list or map. */
export function collectServiceComposeNetworkKeys(service: unknown): string[] {
  if (!isRecord(service)) return []
  const networks = service.networks
  if (networks === undefined || networks === null) return []

  if (typeof networks === 'string') {
    const trimmed = networks.trim()
    return trimmed.length > 0 ? [trimmed] : []
  }
  if (Array.isArray(networks)) return collectNetworkKeysFromList(networks)
  if (isRecord(networks)) {
    return Object.keys(networks).filter((key) => key.trim().length > 0)
  }
  return []
}

/**
 * Drop top-level `networks:` entries that no remaining service references.
 * Project-internal networks used only by stripped traditional-web services must
 * not stay in runtime compose (and must not require org `network` rows).
 */
export function pruneUnreferencedComposeNetworks(
  services: Record<string, unknown>,
  networks: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!networks || Object.keys(networks).length === 0) return undefined

  const referenced = new Set<string>()
  for (const service of Object.values(services)) {
    for (const key of collectServiceComposeNetworkKeys(service)) {
      referenced.add(key)
    }
  }

  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(networks)) {
    if (referenced.has(key)) kept[key] = value
  }

  return Object.keys(kept).length > 0 ? kept : undefined
}
