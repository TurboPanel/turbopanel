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

/**
 * The source of a short `source:target[:mode]` entry, or null for a bare
 * target. A `:` inside `${...}` / `{$...}` belongs to the interpolation
 * (`${X:-./d}:/d`), not to the separator.
 */
function shortSource(entry: string): string | null {
  let depth = 0
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i]
    if (c === '{') depth++
    else if (c === '}' && depth > 0) depth--
    else if (c === ':' && depth === 0) return entry.slice(0, i)
  }
  return null
}

/** Interpolated sources are resolved at deploy time, so they cannot be checked here. */
function isNamedSource(source: string): boolean {
  return source !== '' && !source.includes('$') && !isBindSource(source)
}

function referencedVolumes(service: Record<string, unknown>): string[] {
  if (!Array.isArray(service.volumes)) return []
  const out: string[] = []
  for (const entry of service.volumes) {
    if (typeof entry === 'string') {
      // A bare target is an anonymous volume.
      const source = shortSource(entry)
      if (source !== null && isNamedSource(source)) out.push(source)
    } else if (isRecord(entry) && entry.type === 'volume' && typeof entry.source === 'string') {
      if (isNamedSource(entry.source)) out.push(entry.source)
    }
  }
  return out
}

function referencedNetworks(service: Record<string, unknown>): string[] {
  if (typeof service.network_mode === 'string') return []
  const networks = service.networks
  let names: string[] = []
  if (Array.isArray(networks)) {
    names = networks.filter((n): n is string => typeof n === 'string')
  } else if (isRecord(networks)) {
    names = Object.keys(networks)
  }
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
          message: `Service "${name}" uses ${noun} "${ref}", but the compose does not declare it under a top-level "${section}:" entry. Declare "${ref}" in the project's Base or in this environment's changes.`,
        })
      }
    }
  }
  return issues
}
