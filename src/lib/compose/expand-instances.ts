/**
 * Expand multi-instance compose services into sibling service keys.
 *
 * Compose rejects `container_name` together with `deploy.replicas` / `--scale`,
 * so N instances become sibling services (`web-1` … `web-N`) rather than
 * replicas. Single-instance services keep their original key.
 */

import { isSiteComposeService } from './service-kind.ts'
import type { ComposeDocument } from './types.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type ExpandComposeServiceInstancesResult = {
  document: ComposeDocument
  /** Original compose key → clone keys (single-instance maps to `[original]`). */
  expansion: Map<string, string[]>
}

/**
 * Replace each multi-instance container service with `<name>-1` … `<name>-N`
 * shallow clones, preserving key order. Sites are skipped
 * (host-native; no containers).
 */
export function expandComposeServiceInstances(
  document: ComposeDocument,
  instancesByComposeName: ReadonlyMap<string, number>,
): ExpandComposeServiceInstancesResult {
  const services = isRecord(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {}

  const nextServices: Record<string, unknown> = {}
  const expansion = new Map<string, string[]>()

  for (const [name, raw] of Object.entries(services)) {
    if (!isRecord(raw) || isSiteComposeService(raw)) {
      nextServices[name] = raw
      expansion.set(name, [name])
      continue
    }

    const count = instancesByComposeName.get(name) ?? 1
    if (count <= 1) {
      nextServices[name] = raw
      expansion.set(name, [name])
      continue
    }

    const clones: string[] = []
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const cloneName = `${name}-${ordinal}`
      nextServices[cloneName] = { ...raw }
      clones.push(cloneName)
    }
    expansion.set(name, clones)
  }

  return {
    document: {
      version: 1,
      data: {
        ...document.data,
        services: nextServices,
      },
      presentation: document.presentation,
    },
    expansion,
  }
}
