/**
 * What a new environment takes from the primary environment when it starts as
 * a copy.
 *
 * The copy keeps the services and settings and drops what must be unique per
 * environment: domains and routes, published host ports (the container's own
 * ports stay, moved to `expose` when they were published), fixed container
 * names, and the git branch with push deploys (the source stays; a push never
 * deploys the copy until someone chooses a branch and turns push deploys on).
 * Variables, secrets and the server pin live outside the compose and are never
 * copied. Host-free: no database.
 */
import { makeComposeTag, composeTagOf, isComposeTaggedValue } from '../compose/tags.ts'

export type CopyOmission = 'routes' | 'ports' | 'containerNames' | 'branch'

export type CopiedOptions = {
  options: Record<string, unknown> | null
  /** Plain-words list of what was not copied, for the response. */
  notCopied: string[]
}

const OMISSION_TEXT: Record<CopyOmission, string> = {
  routes: 'Domains and routes: each domain belongs to one environment.',
  ports: 'Published host ports: the services keep their own container ports.',
  containerNames: 'Fixed container names: each environment names its own.',
  branch:
    'The git branch and push deploys: the source is kept, but pushes do not deploy this copy until you choose a branch and turn push deploys on.',
}

const ALWAYS_NOT_COPIED = [
  'Variables and secrets: set them again for this environment.',
  'The server choice: pick a server for this environment.',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Apply `fn` to the value inside a `!reset` / `!override` tag, keeping the tag. */
function throughTag(value: unknown, fn: (inner: unknown) => unknown): unknown {
  if (!isComposeTaggedValue(value)) return fn(value)
  const tag = composeTagOf(value)
  return tag === null ? value : makeComposeTag(tag, fn(value.value))
}

/** The container side of a short-syntax port, or null when it publishes nothing. */
function publishedShortPortTarget(entry: string | number): string | null {
  if (typeof entry === 'number') return null
  const spec = entry.split('/')[0]!
  const segments = spec.split(':')
  return segments.length > 1 ? segments[segments.length - 1]! : null
}

/** The container port a published entry exposed, or `undefined` when it is not published. */
function publishedTarget(entry: unknown): string | null | undefined {
  if (typeof entry === 'string' || typeof entry === 'number') {
    const target = publishedShortPortTarget(entry)
    return target === null ? undefined : target
  }
  if (isRecord(entry) && !isComposeTaggedValue(entry) && entry.published != null) {
    return entry.target == null ? null : String(entry.target)
  }
  return undefined
}

function stripPorts(service: Record<string, unknown>, omitted: Set<CopyOmission>): void {
  if (service.ports === undefined) return
  const dropped: string[] = []
  const rewritten = throughTag(service.ports, (list) => {
    if (!Array.isArray(list)) return list
    return list.filter((entry) => {
      const target = publishedTarget(entry)
      if (target === undefined) return true
      omitted.add('ports')
      if (target !== null) dropped.push(target)
      return false
    })
  })
  const empty = Array.isArray(rewritten) && rewritten.length === 0
  if (empty) delete service.ports
  else service.ports = rewritten
  if (dropped.length === 0) return
  const expose = service.expose
  if (expose === undefined) service.expose = [...new Set(dropped)]
  else if (Array.isArray(expose)) {
    const have = new Set(expose.map(String))
    service.expose = [...expose, ...dropped.filter((port) => !have.has(port))]
  }
}

function stripExtension(service: Record<string, unknown>, omitted: Set<CopyOmission>): void {
  const key = 'x-turbopanel'
  if (service[key] === undefined) return
  service[key] = throughTag(service[key], (raw) => {
    if (!isRecord(raw)) return raw
    const extension: Record<string, unknown> = { ...raw }
    if (extension.hosting !== undefined) {
      delete extension.hosting
      omitted.add('routes')
    }
    if (extension.source !== undefined) {
      extension.source = throughTag(extension.source, (source) => {
        if (!isRecord(source)) return source
        const next: Record<string, unknown> = { ...source }
        if (next.branch !== undefined) omitted.add('branch')
        delete next.branch
        // A source with no branch would follow the repository's default branch
        // on a push, so push deploys go off until someone turns them on.
        next.deployOnPush = false
        return next
      })
    }
    return extension
  })
}

function stripService(raw: unknown, omitted: Set<CopyOmission>): unknown {
  return throughTag(raw, (inner) => {
    if (!isRecord(inner)) return inner
    const service: Record<string, unknown> = { ...inner }
    if (service.container_name !== undefined) {
      delete service.container_name
      omitted.add('containerNames')
    }
    stripPorts(service, omitted)
    stripExtension(service, omitted)
    return service
  })
}

function stripDocument(document: unknown, omitted: Set<CopyOmission>): unknown {
  if (!isRecord(document) || !isRecord(document.data)) return document
  const data: Record<string, unknown> = { ...document.data }
  if (data.services !== undefined) {
    data.services = throughTag(data.services, (services) => {
      if (!isRecord(services)) return services
      return Object.fromEntries(
        Object.entries(services).map(([name, service]) => [name, stripService(service, omitted)])
      )
    })
  }
  return { ...document, data }
}

/**
 * The options a new environment starts with when copied from the primary one:
 * its compose and extra layers, minus what must be unique. `null` options mean
 * the primary has no changes of its own, so there is nothing to copy.
 */
export function copyOfPrimaryOptions(primaryOptions: unknown): CopiedOptions {
  const omitted = new Set<CopyOmission>()
  const copy: Record<string, unknown> = {}
  if (isRecord(primaryOptions)) {
    if (primaryOptions.compose !== undefined && primaryOptions.compose !== null) {
      copy.compose = stripDocument(structuredClone(primaryOptions.compose), omitted)
    }
    const overlays = primaryOptions.composeOverlays
    if (Array.isArray(overlays) && overlays.length > 0) {
      copy.composeOverlays = structuredClone(overlays).map((overlay: unknown) =>
        isRecord(overlay)
          ? { ...overlay, document: stripDocument(overlay.document, omitted) }
          : overlay
      )
    }
  }
  return {
    options: Object.keys(copy).length === 0 ? null : copy,
    notCopied: [...[...omitted].map((key) => OMISSION_TEXT[key]), ...ALWAYS_NOT_COPIED],
  }
}
