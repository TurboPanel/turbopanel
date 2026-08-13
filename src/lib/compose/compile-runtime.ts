/**
 * Compile a runtime Compose document for one server.
 *
 * Users author project + environment documents. Deploy sends one compiled
 * `compose.yaml` per participating daemon. Scheduler-only Swarm `deploy:`
 * keys are stripped so standalone Docker does not reinterpret replica counts.
 */

import { pruneUnreferencedComposeNetworks } from './docker-external-networks.ts'
import { emptyComposeDocument, type ComposeDocument } from './types.ts'

/** Scheduler-only keys never copied into compiled runtime YAML. */
const SCHEDULER_ONLY_DEPLOY_KEYS = new Set([
  'mode',
  'replicas',
  'placement',
  'update_config',
  'rollback_config',
  'endpoint_mode',
])

export type CompileRuntimeOptions = {
  /** When set, identity labels include this environment id. */
  environmentId?: string
  /** When set, drop services not in this set (per-server compile). */
  localServiceNames?: ReadonlySet<string>
  /** Local replica counts keyed by logical compose service name. */
  localReplicaCounts?: ReadonlyMap<string, number>
  /**
   * Logical compose network key → host Docker network name (`tpn_<id>`).
   * Rewritten as `external: true` + `name`.
   */
  spanningNetworks?: ReadonlyMap<string, string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function servicesMapping(document: ComposeDocument): Record<string, unknown> {
  const services = document.data.services
  return isPlainObject(services) ? { ...services } : {}
}

function stripSchedulerDeploy(body: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(body.deploy)) return body
  const deploy = { ...body.deploy }
  for (const key of SCHEDULER_ONLY_DEPLOY_KEYS) {
    delete deploy[key]
  }
  const next = { ...body }
  if (Object.keys(deploy).length === 0) {
    delete next.deploy
  } else {
    next.deploy = deploy
  }
  return next
}

function filterDependsOn(
  dependsOn: unknown,
  localServiceNames: ReadonlySet<string>,
): unknown {
  if (Array.isArray(dependsOn)) {
    const kept = dependsOn.filter(
      (entry) => typeof entry === 'string' && localServiceNames.has(entry),
    )
    return kept.length > 0 ? kept : undefined
  }
  if (!isPlainObject(dependsOn)) return dependsOn
  const kept: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(dependsOn)) {
    if (localServiceNames.has(name)) kept[name] = spec
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

function mergeServiceLabels(
  existing: unknown,
  extra: Record<string, string>,
): unknown {
  if (Array.isArray(existing)) {
    const next = [...existing]
    for (const [key, value] of Object.entries(extra)) {
      const prefix = `${key}=`
      const idx = next.findIndex(
        (item) => typeof item === 'string' && item.startsWith(prefix),
      )
      const rendered = `${key}=${value}`
      if (idx === -1) next.push(rendered)
      else next[idx] = rendered
    }
    return next
  }
  const map = isPlainObject(existing) ? { ...existing } : {}
  for (const [key, value] of Object.entries(extra)) {
    map[key] = value
  }
  return map
}

function applyLocalScale(
  body: Record<string, unknown>,
  replicas: number,
  identityLabels: Record<string, string>,
): Record<string, unknown> {
  const next = { ...body }
  if (replicas > 1) {
    next.scale = replicas
    delete next.container_name
    next.labels = mergeServiceLabels(next.labels, identityLabels)
  }
  return next
}

function rewriteSpanningNetworks(
  networks: Record<string, unknown>,
  spanning: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(networks)) {
    const hostName = spanning.get(key)
    if (hostName) {
      next[key] = { external: true, name: hostName }
      continue
    }
    next[key] = value
  }
  for (const [key, hostName] of spanning) {
    if (!(key in next)) {
      next[key] = { external: true, name: hostName }
    }
  }
  return next
}

function attachDefaultNetworkIfNeeded(
  services: Record<string, unknown>,
  spanning: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!spanning.has('default')) return services
  const next: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw) || raw.networks !== undefined) {
      next[name] = raw
      continue
    }
    next[name] = { ...raw, networks: ['default'] }
  }
  return next
}

function pruneUnreferencedVolumes(
  services: Record<string, unknown>,
  volumes: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!volumes || Object.keys(volumes).length === 0) return undefined

  const referenced = new Set<string>()
  for (const service of Object.values(services)) {
    if (!isPlainObject(service) || !Array.isArray(service.volumes)) continue
    for (const mount of service.volumes) {
      if (typeof mount !== 'string') continue
      const source = mount.split(':')[0]
      if (source && source in volumes) referenced.add(source)
    }
  }

  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(volumes)) {
    if (referenced.has(key)) kept[key] = value
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

function referencedSecretSources(services: Record<string, unknown>): Set<string> {
  const referenced = new Set<string>()
  for (const service of Object.values(services)) {
    if (!isPlainObject(service)) continue
    collectSecretSources(service.secrets, referenced)
    if (isPlainObject(service.build)) {
      collectSecretSources(service.build.secrets, referenced)
    }
  }
  return referenced
}

function collectSecretSources(value: unknown, referenced: Set<string>): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item === 'string') {
      referenced.add(item)
      continue
    }
    if (isPlainObject(item) && typeof item.source === 'string') {
      referenced.add(item.source)
    }
  }
}

function pruneUnreferencedSecrets(
  services: Record<string, unknown>,
  secrets: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!secrets || Object.keys(secrets).length === 0) return undefined
  const referenced = referencedSecretSources(services)
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(secrets)) {
    if (referenced.has(key)) kept[key] = value
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

/**
 * Produce the per-server runtime document. Phase 1 callers omit local filters
 * so the full effective document is compiled with scheduler keys stripped.
 */
export function compileRuntimeComposeDocument(
  document: ComposeDocument,
  options?: CompileRuntimeOptions,
): ComposeDocument {
  const localNames = options?.localServiceNames
  const replicaCounts = options?.localReplicaCounts
  const spanning = options?.spanningNetworks
  const environmentId = options?.environmentId

  const sourceServices = servicesMapping(document)
  const nextServices: Record<string, unknown> = {}

  for (const [name, raw] of Object.entries(sourceServices)) {
    if (localNames && !localNames.has(name)) continue
    if (!isPlainObject(raw)) {
      nextServices[name] = raw
      continue
    }

    let body = stripSchedulerDeploy(cloneJson(raw))
    if (localNames) {
      const dependsOn = filterDependsOn(body.depends_on, localNames)
      if (dependsOn === undefined) delete body.depends_on
      else body.depends_on = dependsOn
    }

    const replicas = replicaCounts?.get(name) ?? 1
    if (replicas < 1) continue
    const identityLabels: Record<string, string> = {
      'com.turbopanel.service': name,
    }
    if (environmentId) {
      identityLabels['com.turbopanel.environment'] = environmentId
    }
    body = applyLocalScale(body, replicas, identityLabels)
    nextServices[name] = body
  }

  const compiledServices = spanning && spanning.size > 0
    ? attachDefaultNetworkIfNeeded(nextServices, spanning)
    : nextServices

  const data: Record<string, unknown> = { ...document.data, services: compiledServices }

  const sourceNetworks = isPlainObject(document.data.networks)
    ? { ...document.data.networks }
    : {}
  if (spanning && spanning.size > 0) {
    const networks = rewriteSpanningNetworks(sourceNetworks, spanning)
    const pruned = pruneUnreferencedComposeNetworks(compiledServices, networks)
    if (pruned) data.networks = pruned
    else delete data.networks
  } else if (Object.keys(sourceNetworks).length > 0) {
    const pruned = pruneUnreferencedComposeNetworks(compiledServices, sourceNetworks)
    if (pruned) data.networks = pruned
    else delete data.networks
  }

  if (isPlainObject(document.data.volumes)) {
    const prunedVolumes = pruneUnreferencedVolumes(
      compiledServices,
      document.data.volumes,
    )
    if (prunedVolumes) data.volumes = prunedVolumes
    else delete data.volumes
  }

  if (isPlainObject(document.data.secrets)) {
    const prunedSecrets = pruneUnreferencedSecrets(
      compiledServices,
      document.data.secrets,
    )
    if (prunedSecrets) data.secrets = prunedSecrets
    else delete data.secrets
  }

  if (Object.keys(compiledServices).length === 0 && !data.networks && !data.volumes) {
    return emptyComposeDocument()
  }

  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}
