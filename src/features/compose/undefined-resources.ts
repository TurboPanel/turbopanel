/**
 * Top-level compose resources a service still uses.
 *
 * A service that mounts a named volume, joins a network or takes a secret or
 * config needs that resource declared at the top level; Docker Compose refuses
 * the project otherwise ("service refers to undefined volume"). Saving a layer
 * that drops the declaration is refused here, at save, rather than failing the
 * next deploy.
 *
 * Pure and host-free. Works on the merged document with `!reset` / `!override`
 * already resolved.
 */

import { resolveComposeTags } from './tags.ts'

export type UndefinedResourceIssue = { path: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Bind-style short sources are paths, not named volumes. */
function isBindSource(source: string): boolean {
  return (
    source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~') ||
    source === '.' ||
    source === '..'
  )
}

function declared(data: Record<string, unknown>, key: string): ReadonlySet<string> {
  const section = data[key]
  return new Set(isRecord(section) ? Object.keys(section) : [])
}

function referencedVolumes(service: Record<string, unknown>): string[] {
  if (!Array.isArray(service.volumes)) return []
  const out: string[] = []
  for (const entry of service.volumes) {
    if (typeof entry === 'string') {
      const parts = entry.split(':')
      // A bare target is an anonymous volume.
      if (parts.length < 2) continue
      const source = parts[0] ?? ''
      if (source !== '' && !isBindSource(source)) out.push(source)
    } else if (isRecord(entry) && entry.type === 'volume' && typeof entry.source === 'string') {
      if (entry.source !== '') out.push(entry.source)
    }
  }
  return out
}

function referencedNetworks(service: Record<string, unknown>): string[] {
  if (typeof service.network_mode === 'string') return []
  const networks = service.networks
  const names = Array.isArray(networks)
    ? networks.filter((n): n is string => typeof n === 'string')
    : isRecord(networks)
      ? Object.keys(networks)
      : []
  return names.filter((n) => n !== 'default' && n !== 'host' && n !== 'none')
}

function referencedSources(service: Record<string, unknown>, key: 'secrets' | 'configs'): string[] {
  const list = service[key]
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') out.push(entry)
    else if (isRecord(entry) && typeof entry.source === 'string') {
      out.push(entry.source)
    }
  }
  return out
}

const KINDS = [
  ['volumes', 'volume', referencedVolumes],
  ['networks', 'network', referencedNetworks],
  ['secrets', 'secret', (s: Record<string, unknown>) => referencedSources(s, 'secrets')],
  ['configs', 'config', (s: Record<string, unknown>) => referencedSources(s, 'configs')],
] as const

/** One issue per service and undefined top-level resource it refers to. */
export function undefinedResourceIssues(data: Record<string, unknown>): UndefinedResourceIssue[] {
  const resolved = resolveComposeTags(data) as Record<string, unknown>
  const services = resolved.services
  if (!isRecord(services)) return []
  const issues: UndefinedResourceIssue[] = []
  for (const [section, noun, references] of KINDS) {
    const known = declared(resolved, section)
    for (const [name, service] of Object.entries(services)) {
      if (!isRecord(service)) continue
      for (const ref of new Set(references(service))) {
        if (known.has(ref)) continue
        issues.push({
          path: `services.${name}`,
          message: `Service "${name}" uses ${noun} "${ref}", but no top-level "${section}" entry declares it - this save would drop it. Keep the "${ref}" entry under "${section}:" (in the project's Base or in this environment's changes).`,
        })
      }
    }
  }
  return issues
}
