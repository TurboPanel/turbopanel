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
import { isComposeChainError, resolveComposeLayerChain } from '../compose/layer-chain.ts'
import { mergeComposeLayers } from '../compose/layers.ts'
import { makeComposeTag, composeTagOf, isComposeTaggedValue } from '../compose/tags.ts'

export type CopyOmission = 'routes' | 'ports' | 'containerNames' | 'branch' | 'pushDeploys'

export type CopiedOptions = {
  options: Record<string, unknown> | null
  /** Plain-words list of what was not copied, for the response. */
  notCopied: string[]
}

const OMISSION_TEXT: Record<CopyOmission, string> = {
  routes: 'Domains and routes: each domain belongs to one environment.',
  ports: 'Published host ports: the services keep their own container ports.',
  containerNames: 'Fixed container names: each environment names its own.',
  branch: 'The git branch: the source is kept, choose a branch for this environment.',
  pushDeploys:
    'Push deploys: turned off for this copy, so a push never deploys it until you choose a branch and turn them on.',
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

/** The container side of a short-syntax port (protocol kept), or null when it publishes nothing. */
function publishedShortPortTarget(entry: string | number): string | null {
  if (typeof entry === 'number') return null
  const [spec = '', protocol] = entry.split('/')
  const segments = spec.split(':')
  const target = segments.length > 1 ? segments.at(-1) : undefined
  if (!target) return null
  return protocol ? `${target}/${protocol}` : target
}

/** The container port a published long-syntax entry exposed (protocol kept). */
function publishedLongPortTarget(entry: Record<string, unknown>): string | null {
  const target = entry.target
  if (typeof target !== 'string' && typeof target !== 'number') return null
  const protocol =
    typeof entry.protocol === 'string' && entry.protocol !== 'tcp' ? entry.protocol : null
  return protocol ? `${target}/${protocol}` : String(target)
}

/** The container port a published entry exposed, or `undefined` when it is not published. */
function publishedTarget(entry: unknown): string | null | undefined {
  if (typeof entry === 'string' || typeof entry === 'number') {
    return publishedShortPortTarget(entry) ?? undefined
  }
  if (isRecord(entry) && !isComposeTaggedValue(entry) && entry.published != null) {
    return publishedLongPortTarget(entry)
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
        if (next.deployOnPush !== false) omitted.add('pushDeploys')
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

type Plain = Record<string, unknown>

/** What the Base (merged with the copy's own layer) still gives a service that must be unique. */
function inheritedOverrides(service: Plain, omitted: Set<CopyOmission>): Plain | null {
  const fixes: Plain = {}
  if (service.container_name !== undefined) {
    fixes.container_name = makeComposeTag('reset', null)
    omitted.add('containerNames')
  }
  if (Array.isArray(service.ports)) {
    const kept = service.ports.filter((entry) => publishedTarget(entry) === undefined)
    if (kept.length !== service.ports.length) {
      fixes.ports = makeComposeTag('override', kept)
      omitted.add('ports')
    }
  }
  const extension: Plain = {}
  const inherited = isRecord(service['x-turbopanel']) ? service['x-turbopanel'] : {}
  if (inherited.hosting !== undefined) {
    extension.hosting = makeComposeTag('reset', null)
    omitted.add('routes')
  }
  if (isRecord(inherited.source)) {
    const source: Plain = {}
    // The branch itself cannot be reset from a layer (a branch must be a string),
    // so the copy keeps it and push deploys go off instead.
    if (inherited.source.deployOnPush !== false) {
      source.deployOnPush = false
      omitted.add('pushDeploys')
    }
    if (Object.keys(source).length > 0) extension.source = source
  }
  if (Object.keys(extension).length > 0) fixes['x-turbopanel'] = extension
  return Object.keys(fixes).length > 0 ? fixes : null
}

/** Recursive merge of plain objects; tagged values and lists in `fixes` replace. */
function mergeFixes(target: Plain, fixes: Plain): Plain {
  const out: Plain = { ...target }
  for (const [key, value] of Object.entries(fixes)) {
    const current = out[key]
    out[key] =
      isRecord(value) &&
      !isComposeTaggedValue(value) &&
      isRecord(current) &&
      !isComposeTaggedValue(current)
        ? mergeFixes(current, value)
        : value
  }
  return out
}

/**
 * Every environment inherits the Base, so the copy's own layer must also
 * override what the Base (plus the copy's layer) still gives: a hostname,
 * published ports, a fixed container name, or an auto-deploying source. The
 * overrides use the compose merge's own `!reset` / `!override`.
 */
function overrideInherited(copy: Plain, projectOptions: unknown, omitted: Set<CopyOmission>): void {
  const layers = resolveComposeLayerChain({
    projectOptions,
    environmentOptions: copy,
    environmentFilename: 'docker-compose.environment.yml',
  })
  if (isComposeChainError(layers)) return
  const effective = mergeComposeLayers(layers).data.services
  if (!isRecord(effective)) return

  const fixesByService = new Map<string, Plain>()
  for (const [name, service] of Object.entries(effective)) {
    const fixes = isRecord(service) ? inheritedOverrides(service, omitted) : null
    if (fixes) fixesByService.set(name, fixes)
  }
  if (fixesByService.size === 0) return

  const document = isRecord(copy.compose)
    ? (copy.compose as Plain)
    : { version: 1, data: {}, presentation: { keyOrder: [], comments: {} } }
  const data: Plain = isRecord(document.data) ? { ...document.data } : {}
  const services: Plain = isRecord(data.services) ? { ...data.services } : {}
  for (const [name, fixes] of fixesByService) {
    const own = services[name]
    if (own !== undefined && !isRecord(own)) continue
    if (isComposeTaggedValue(own)) continue
    services[name] = mergeFixes(isRecord(own) ? own : {}, fixes)
  }
  data.services = services
  copy.compose = { ...document, data }
}

/**
 * The options a new environment starts with when copied from the primary one:
 * its compose and extra layers, minus what must be unique, plus overrides for
 * what the Base would still hand it. `null` options mean there is nothing to
 * copy or override.
 */
export function copyOfPrimaryOptions(
  primaryOptions: unknown,
  projectOptions: unknown
): CopiedOptions {
  const omitted = new Set<CopyOmission>()
  const copy: Plain = {}
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
  overrideInherited(copy, projectOptions, omitted)
  return {
    options: Object.keys(copy).length === 0 ? null : copy,
    notCopied: [...[...omitted].map((key) => OMISSION_TEXT[key]), ...ALWAYS_NOT_COPIED],
  }
}
