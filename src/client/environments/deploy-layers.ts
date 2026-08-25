/**
 * Pure multi-file compose layer builders for deploy.
 *
 * Host-free (no DB/Hono) so Deno unit tests can import this module directly.
 * Removals are rendered out of user layers at emit time (never `!reset`) so
 * pre-Compose-Spec-2.24 hosts still work. Platform injections are a bounded
 * key-diff of the prepared effective document vs the user-merged view.
 */

import {
  COMPOSE_FILE_NAME_RE,
  type EnvironmentDeployComposeFile,
} from '../../lib/commands/schemas.ts'
import {
  emptyContainerComposeYaml,
  emptyComposeDocument,
  renameComposeVolumesInLayer,
  stripComposePlacementFromLayer,
  stripComposeTurbopanelExtensions,
  stripSiteServicesFromLayer,
  type ComposeDocument,
} from '../../lib/compose/index.ts'

export const PROJECT_COMPOSE_FILENAME = 'docker-compose.yml'
export const PLATFORM_COMPOSE_FILENAME = 'docker-compose.turbopanel.yml'
export const RUNTIME_COMPOSE_FILENAME = 'compose.yaml'

/** Platform-injected service keys (scalar or mapping — never sequences). */
const PLATFORM_SERVICE_SCALAR_KEYS = new Set([
  'container_name',
  'stop_grace_period',
  'cpus',
  'mem_limit',
  'mem_reservation',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const COMPOSE_SLUG_SEPARATORS = new Set(['-', '.', '_'])

function isComposeSlugChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z')
    || (ch >= '0' && ch <= '9')
    || ch === '.' || ch === '_' || ch === '-'
}

function isComposeSlugSeparator(ch: string): boolean {
  return COMPOSE_SLUG_SEPARATORS.has(ch)
}

/** Linear-time slug for `docker-compose.<basename>.yml` (Sonar typescript:S8786). */
function slugComposeBasename(raw: string): string {
  let slug = ''
  for (const ch of raw.toLowerCase()) {
    slug += isComposeSlugChar(ch) ? ch : '-'
  }
  let collapsed = ''
  let inSep = false
  for (const ch of slug) {
    if (isComposeSlugSeparator(ch)) {
      if (!inSep) {
        collapsed += ch
        inSep = true
      }
    } else {
      inSep = false
      collapsed += ch
    }
  }
  let start = 0
  let end = collapsed.length
  while (start < end && isComposeSlugSeparator(collapsed[start])) start++
  while (end > start && isComposeSlugSeparator(collapsed[end - 1])) end--
  return collapsed.slice(start, end)
}

function sanitizeComposeIdSegment(id: string): string {
  let out = ''
  for (const ch of id) {
    const isAlnum = (ch >= 'A' && ch <= 'Z')
      || (ch >= 'a' && ch <= 'z')
      || (ch >= '0' && ch <= '9')
    out += (isAlnum || ch === '.' || ch === '_' || ch === '-') ? ch : '-'
  }
  return out
}

/**
 * Environment overlay filename: `docker-compose.<slug>.yml`.
 * Falls back to the environment id when the name is blank/unusable or the
 * result would collide with the project/platform basenames.
 */
export function environmentComposeFilename(params: Readonly<{
  id: string
  name: string | null | undefined
}>): string {
  const raw = typeof params.name === 'string' ? params.name.trim() : ''
  const slug = slugComposeBasename(raw)

  const tryFilename = (base: string): string | null => {
    if (base.length === 0) return null
    const filename = `docker-compose.${base}.yml`
    if (!COMPOSE_FILE_NAME_RE.test(filename)) return null
    if (filename === PROJECT_COMPOSE_FILENAME) return null
    if (filename === PLATFORM_COMPOSE_FILENAME) return null
    return filename
  }

  const fromName = tryFilename(slug)
  if (fromName) return fromName

  const fromId = tryFilename(params.id)
  if (fromId) return fromId

  // UUID/id should always satisfy the regex; last-resort basename.
  return `docker-compose.${sanitizeComposeIdSegment(params.id)}.yml`
}

/**
 * Drop top-level `networks:` keys not in `keep`.
 *
 * The prune decision stays merged-view-only (`pruneUnreferencedComposeNetworks`
 * on the effective document); layers just apply its outcome. Removals are
 * rendered out of YAML rather than expressed as `!reset` so pre-2.24 Compose
 * still works.
 */
function keepTopLevelNetworkKeys(
  document: ComposeDocument,
  keepNetworkKeys: ReadonlySet<string>,
): ComposeDocument {
  const networks = document.data.networks
  if (networks === undefined) return document
  if (!isPlainObject(networks)) {
    // Non-mapping networks value cannot have keys pruned usefully — drop it
    // when keep is empty so the layer does not reintroduce a pruned tree.
    if (keepNetworkKeys.size === 0) {
      const { networks: _drop, ...rest } = document.data
      return {
        version: 1,
        data: rest,
        presentation: document.presentation,
      }
    }
    return document
  }

  const nextNetworks: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(networks)) {
    if (keepNetworkKeys.has(key)) nextNetworks[key] = value
  }

  const data = { ...document.data }
  if (Object.keys(nextNetworks).length === 0) {
    delete data.networks
  } else {
    data.networks = nextNetworks
  }
  return {
    version: 1,
    data,
    presentation: document.presentation,
  }
}

/**
 * The per-layer transform every user layer goes through. Exported so its
 * behaviour is tested directly rather than through a builder — the old
 * `buildUserComposeLayers` was the only caller and had none of its own.
 */
export function transformUserLayerDocument(
  document: ComposeDocument,
  removeServiceNames: ReadonlySet<string>,
  volumeRenames: ReadonlyMap<string, string>,
  keepNetworkKeys: ReadonlySet<string>,
): ComposeDocument {
  // 1–4: placement → TW/expanded-key removals → volume renames → hidden ext.
  // removeServiceNames is the **union** of site names (from
  // collectSiteServiceNames on the merged doc) and expanded origin
  // keys — merged-view-driven key removal, not per-layer detection.
  let next = stripComposePlacementFromLayer(document)
  next = stripSiteServicesFromLayer(next, removeServiceNames)
  next = renameComposeVolumesInLayer(next, volumeRenames)
  next = stripComposeTurbopanelExtensions(next)
  // 5: apply merged prune outcome (network keys surviving prune).
  return keepTopLevelNetworkKeys(next, keepNetworkKeys)
}


/** One-level mapping diff: keys new or changed in effective vs base. */
function mappingDiff(
  effective: Record<string, unknown>,
  base: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(effective)) {
    if (base === undefined || !(key in base) || !valuesEqual(base[key], value)) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function servicesMapping(document: ComposeDocument): Record<string, unknown> {
  return isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {}
}

function topLevelMapping(
  document: ComposeDocument,
  key: 'networks' | 'volumes',
): Record<string, unknown> {
  return isPlainObject(document.data[key])
    ? (document.data[key] as Record<string, unknown>)
    : {}
}

/** Diff `PLATFORM_SERVICE_SCALAR_KEYS` present on `effectiveBody` vs `user`. */
function diffScalarKeys(
  effectiveBody: Record<string, unknown>,
  user: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of PLATFORM_SERVICE_SCALAR_KEYS) {
    if (!(key in effectiveBody)) continue
    if (!(key in user) || !valuesEqual(user[key], effectiveBody[key])) {
      out[key] = effectiveBody[key]
    }
  }
  return out
}

/** `mappingDiff` guarded for non-mapping `effective`/`user` values. */
function diffNestedMapping(
  effective: unknown,
  user: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(effective)) return undefined
  return mappingDiff(effective, isPlainObject(user) ? user : undefined)
}

/**
 * Diff one shared service: only platform-injected scalar/mapping keys.
 * Recurses one level into `deploy`, `environment`, and `build.args`.
 */
function diffSharedService(
  effectiveBody: unknown,
  userBody: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(effectiveBody)) return undefined
  const user = isPlainObject(userBody) ? userBody : {}
  const out: Record<string, unknown> = diffScalarKeys(effectiveBody, user)

  const deployDiff = diffNestedMapping(effectiveBody.deploy, user.deploy)
  if (deployDiff) out.deploy = deployDiff

  const envDiff = diffNestedMapping(effectiveBody.environment, user.environment)
  if (envDiff) out.environment = envDiff

  const buildArgsDiff = diffNestedMapping(
    isPlainObject(effectiveBody.build) ? effectiveBody.build.args : undefined,
    isPlainObject(user.build) ? user.build.args : undefined,
  )
  if (buildArgsDiff) out.build = { args: buildArgsDiff }

  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Platform layer: full bodies for services only present in `effective`
 * (expanded siblings), plus a bounded-key diff for shared services, plus
 * top-level networks/volumes that appear only after prepare.
 */
export function buildPlatformComposeLayer(params: Readonly<{
  effective: ComposeDocument
  userMerged: ComposeDocument
}>): ComposeDocument {
  const effectiveServices = servicesMapping(params.effective)
  const userServices = servicesMapping(params.userMerged)
  const nextServices: Record<string, unknown> = {}

  for (const [name, body] of Object.entries(effectiveServices)) {
    if (!(name in userServices)) {
      // Expanded siblings (web-1…web-N): overlays do not inherit across new
      // service keys — emit the full effective body.
      nextServices[name] = body
      continue
    }
    const patch = diffSharedService(body, userServices[name])
    if (patch) nextServices[name] = patch
  }

  const data: Record<string, unknown> = {}
  if (Object.keys(nextServices).length > 0) {
    data.services = nextServices
  }

  // Safety net for top-level networks/volumes present only after prepare
  // (normally empty when user layers already carry registered keys).
  const networkDiff = mappingDiff(
    topLevelMapping(params.effective, 'networks'),
    topLevelMapping(params.userMerged, 'networks'),
  )
  if (networkDiff) data.networks = networkDiff

  const volumeDiff = mappingDiff(
    topLevelMapping(params.effective, 'volumes'),
    topLevelMapping(params.userMerged, 'volumes'),
  )
  if (volumeDiff) data.volumes = volumeDiff

  if (Object.keys(data).length === 0) return emptyComposeDocument()

  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}

/**
 * Single compiled runtime file the daemon writes as `compose.yaml`.
 */
export function renderRuntimeComposeFiles(
  content: string,
): EnvironmentDeployComposeFile[] {
  const body = content.trim() === '' ? emptyContainerComposeYaml() : content
  return [
    {
      filename: RUNTIME_COMPOSE_FILENAME,
      role: 'runtime',
      source: 'inline',
      content: body.endsWith('\n') ? body : `${body}\n`,
    },
  ]
}

/**
 * Origin service keys replaced by multi-instance expansion (`web` → `web-1`…).
 * Single-instance keys where clones === `[origin]` are left alone.
 */
export function expandedOriginServiceNames(
  expansion: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>,
): Set<string> {
  const names = new Set<string>()
  const entries: Iterable<[string, readonly string[]]> = expansion instanceof Map
    ? expansion.entries()
    : Object.entries(expansion)
  for (const [origin, clones] of entries) {
    if (clones.length !== 1 || clones[0] !== origin) {
      names.add(origin)
    }
  }
  return names
}

/** Convenience re-export for tests that want the full assemble path. */
export { mergeComposeLayers, stripComposeTurbopanelExtensions } from '../../lib/compose/index.ts'
