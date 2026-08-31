import {
  isMap,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'
import { COMPOSE_YAML_OPTIONS } from './tags.ts'
import {
  type ComposeServiceKind,
  SUPPORTED_NODE_SERIES,
  TURBOPANEL_SERVICE_EXTENSION_KEY,
} from './service-kind.ts'
import {
  HOSTING_HOSTNAME_REQUIRED_MESSAGE,
  HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE,
  HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE,
  HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE,
  hostingIpRefUnresolvedMessage,
  hostingTargetPortAuthorable,
  hostingTlsRefUnresolvedMessage,
  readHostingHostname,
} from './hosting-extension.ts'
import { parseExactVariableRef } from './variable-refs.ts'
import {
  isNativeAppRestartCondition,
  isNativeAppRestartDuration,
  isNativeAppRestartMaxAttempts,
  NATIVE_APP_RESTART_CONDITIONS,
} from './native-app.ts'
import {
  classifyDeployKey,
  classifyDeployResourcesKey,
  classifyNetworkKey,
  classifyServiceKey,
  classifyTopLevelKey,
  SERVICE_FIELD_KEYS,
  SPANNING_NETWORK_DRIVER,
  TOP_LEVEL_FIELD_KEYS,
  unsupportedDeployReason,
  unsupportedDeployResourcesReason,
  unsupportedNetworkReason,
} from './field-policy.ts'
import { validateAgainstUpstreamSchema } from './upstream-schema.ts'

export type ComposeLintLevel = 'error' | 'warning'

/**
 * Machine-readable rule identity, for the callers that need to act on *which*
 * rule fired rather than on the prose.
 *
 * Only the rules something downstream keys off carry one — deploy-prepare has
 * to tell "this field is unsupported by TurboPanel" apart from every other lint
 * finding, because that one alone is a hard deploy refusal while the rest stay
 * save-time advice. Matching on message text would make the diagnostic wording
 * load-bearing.
 */
export type ComposeLintCode = 'field_unsupported' | 'turbofabric_required'

export type ComposeLintIssue = {
  level: ComposeLintLevel
  message: string
  /** Set only for rules a caller keys off; see {@link ComposeLintCode}. */
  code?: ComposeLintCode
  /** Dot-joined location within the compose tree (e.g. `services.nginx.imaage`). */
  path: string
  /** 1-based source line, when it can be resolved from the YAML. */
  line?: number
  /**
   * When false, never blocks save even if the level is `warning`/`error`.
   * Used for advisory-only tags in the base layer.
   */
  blocking?: false
}

export type ComposeLintOptions = {
  /**
   * Layer role for tag semantics. Defaults to `base` (existing zero-arg calls
   * unchanged). Tags only take effect in an overlay; on base they emit a
   * non-blocking advisory warning.
   */
  layer?: 'base' | 'overlay'
  /**
   * Every `source.id` visible to the caller's organization. The linter is pure
   * (no database), so the route layer queries the set once per request and
   * passes it in; when omitted the `sourceId` resolution check is **skipped**
   * entirely rather than false-flagging.
   */
  knownSourceIds?: ReadonlySet<string>
  /**
   * The repository this project is bound to, when it has one.
   *
   * **A repository-backed project is its repository.** Every
   * `x-turbopanel.source.sourceId` in the document has to name this row —
   * several repositories in one project would mean several answers to "what is
   * deployed here", and the per-service block exists for the *other* half of
   * the question (`branch`, `subdirectory`, `buildCommand`), which is how one
   * checkout builds two services out of a monorepo.
   *
   * `null` means the project has no binding yet. The rule does not go away
   * then, it weakens to "at most one distinct id", because the save that
   * introduces the first repository is exactly the save the project adopts it
   * on (`project.repository_id`) — so a document that names two is rejected
   * whether or not the column is set yet.
   *
   * Omitted entirely (`undefined`) skips the rule, the same way
   * {@link ComposeLintOptions.knownSourceIds} does: a caller with no project
   * context must not be made to false-flag.
   */
  projectRepositoryId?: string | null
  /**
   * Every principal alias in scope for this document — its own root
   * `x-turbopanel.principals`, plus (for an overlay) the project base's.
   *
   * Same contract as {@link ComposeLintOptions.knownSourceIds}: the linter is
   * pure, the caller assembles the set, and omitting it **skips** the rule
   * rather than false-flagging every service in a document whose sibling layer
   * the caller could not see.
   */
  knownPrincipalAliases?: ReadonlySet<string>
  /**
   * Every `tls.id` visible to the caller's organization, for
   * `x-turbopanel.hosting[i].tls.certificateRef`.
   *
   * Same contract as {@link ComposeLintOptions.knownSourceIds} — the linter is
   * pure, the route layer queries the set once per request, and omitting it
   * **skips** the resolution rule rather than false-flagging every route in a
   * document the caller could not resolve refs for. A ref may name a row by id
   * or by name, so the caller assembles both spellings into one set.
   */
  knownTlsIds?: ReadonlySet<string>
  /**
   * Every managed address visible to the caller's organization, for
   * `x-turbopanel.hosting[i].bind.ipRef`. Same contract as
   * {@link ComposeLintOptions.knownTlsIds}; ids and addresses share the set.
   */
  knownIpIds?: ReadonlySet<string>
  /**
   * Deploy-time posture for the field-policy rules (`./field-policy.ts`).
   *
   * A field TurboPanel cannot honour is two different things depending on when
   * you ask. While editing it is *advice* — the author is mid-thought, the
   * document is a draft, and refusing the save would strand them. At deploy it
   * is a *refusal*: the alternative is running something quietly different from
   * what the document says, which is the exact failure this registry exists to
   * end.
   *
   * So the rule is one rule and the severity is the caller's: save-time routes
   * leave this `false` (non-blocking warning), deploy-prepare passes `true`
   * (blocking error). Scoped to the field-policy diagnostics on purpose —
   * every other rule keeps the blocking behaviour it already had, so turning
   * this on cannot retroactively fail a document for an unrelated reason.
   */
  strict?: boolean
}

/**
 * The DB-resolved sets a caller can hand the linter, bundled.
 *
 * One object rather than four positional parameters threaded through
 * `lintTopLevel` → `lintServices` → `lintService`: every one of these is the
 * same kind of fact — "here is what actually resolves for this organization" —
 * and each is independently optional, with omission meaning *skip the rule*
 * rather than fail it. A parameter list that grew one slot per reference kind
 * is how a caller ends up passing them in the wrong order.
 */
type KnownComposeReferences = {
  sourceIds?: ReadonlySet<string>
  principalAliases?: ReadonlySet<string>
  tlsIds?: ReadonlySet<string>
  ipIds?: ReadonlySet<string>
}

/** Draft-only warnings that must not block saving a blank/empty compose. */
const DRAFT_ALLOWED_LINT_MESSAGES = new Set([
  'Compose file has no "services" section',
  'No services defined',
])

const BASE_LAYER_TAG_ADVISORY =
  '!reset / !override only take effect in an overlay compose file'

/**
 * Non-blocking notice. The block is no longer inert — deploy-prepare turns it
 * into `sourceMaterial[]` and the daemon builds and promotes a release — but it
 * still does not decide document roots or process supervision, so an author who
 * expects it to change how the service runs needs to hear that.
 */
const SOURCE_INERT_ADVISORY =
  'x-turbopanel.source builds and promotes a release, but does not yet change how this service is served or supervised'

function isExtensionKey(key: string): boolean {
  return key.startsWith('x-')
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dist = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i += 1) dist[i]![0] = i
  for (let j = 0; j < cols; j += 1) dist[0]![j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dist[i]![j] = Math.min(
        dist[i - 1]![j]! + 1,
        dist[i]![j - 1]! + 1,
        dist[i - 1]![j - 1]! + cost,
      )
    }
  }
  return dist[a.length]![b.length]!
}

/** Nearest allowed key within edit distance 2, for "did you mean" hints. */
function suggestKey(key: string, allowed: Iterable<string>): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const candidate of allowed) {
    const distance = levenshtein(key, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function unknownKeyMessage(
  key: string,
  kind: string,
  allowed: Iterable<string>,
): string {
  const suggestion = suggestKey(key, allowed)
  const base = `Unknown ${kind} key "${key}"`
  return suggestion ? `${base} — did you mean "${suggestion}"?` : base
}

function nodeLine(
  node: Node | null | undefined,
  lineCounter: LineCounter,
): number | undefined {
  const range = (node as { range?: [number, number, number] } | null)?.range
  if (!range) return undefined
  return lineCounter.linePos(range[0]).line
}

function stringKey(key: unknown): string | null {
  if (key && typeof key === 'object' && 'value' in (key as object)) {
    const value = (key as { value: unknown }).value
    if (typeof value === 'string') return value
  }
  return null
}

/** Raw scalar payload of a YAML node, or `undefined` when it is not a scalar. */
function scalarValueOf(node: Node | null | undefined): unknown {
  if (!node || typeof node !== 'object' || !('value' in node)) return undefined
  return (node as Scalar).value
}

function scalarString(node: Node | null | undefined): string | null {
  if (!node || typeof node !== 'object' || !('value' in node)) return null
  const value = (node as Scalar).value
  return typeof value === 'string' ? value : null
}

/** True when the YAML node carries Compose Spec `!reset` / `!override`. */
function isTaggedNode(node: Node | null | undefined): boolean {
  if (!node || typeof node !== 'object') return false
  const tag = (node as { tag?: string }).tag
  return tag === '!reset' || tag === '!override'
}

/** True when an `image` key is present but empty/missing (not a real image ref). */
function isEmptyImageValue(node: Node | null | undefined): boolean {
  if (!node || typeof node !== 'object' || !('value' in node)) return false
  const value = (node as Scalar).value
  if (value === null || value === undefined) return true
  return typeof value === 'string' && value.trim().length === 0
}

/**
 * `image` / `build` is required only of Docker services. Sites
 * are served by a host engine and `node` apps are supervised from a Git
 * release, so neither declares one.
 */
const HOST_NATIVE_SERVICE_KINDS = new Set(['site', 'node'])

/** The `x-turbopanel` map on a service node, or null when absent or not a map. */
function serviceExtensionMap(valueNode: YAMLMap): YAMLMap | null {
  for (const item of valueNode.items) {
    if (stringKey(item.key) !== TURBOPANEL_SERVICE_EXTENSION_KEY) continue
    return isMap(item.value) ? (item.value as YAMLMap) : null
  }
  return null
}

/** Value node for `key` in a YAML map, or undefined when the key is absent. */
function mapEntryValue(node: YAMLMap, key: string): Node | null | undefined {
  for (const item of node.items) {
    if (stringKey(item.key) === key) return item.value as Node | null
  }
  return undefined
}

function serviceIsHostNative(valueNode: YAMLMap): boolean {
  const extension = serviceExtensionMap(valueNode)
  if (!extension) return false
  const kind = scalarString(mapEntryValue(extension, 'serviceKind'))
  return kind !== null && HOST_NATIVE_SERVICE_KINDS.has(kind)
}

/**
 * True for `serviceKind: node` specifically — narrower than
 * {@link serviceIsHostNative}, which also covers sites.
 *
 * The `deploy.restart_policy` rule needs the narrow question: a `node` service
 * is supervised by a generated systemd unit that can only express part of the
 * Compose vocabulary, while a site has no process of its own for a restart
 * policy to govern and a container service hands the whole block to Docker.
 */
function serviceIsNativeApp(valueNode: YAMLMap): boolean {
  const extension = serviceExtensionMap(valueNode)
  if (!extension) return false
  return scalarString(mapEntryValue(extension, 'serviceKind'))?.trim() === 'node'
}

/**
 * True when `x-turbopanel.source.buildKind` is `railpack`.
 *
 * Deliberately a sibling of {@link serviceIsHostNative} rather than another
 * entry in {@link HOST_NATIVE_SERVICE_KINDS}: a Railpack service *is* a Docker
 * service — it just gets its `image` minted by the daemon at deploy time from
 * the built OCI image, so there is nothing for the author to type here.
 */
function serviceIsRailpackBuilt(valueNode: YAMLMap): boolean {
  const extension = serviceExtensionMap(valueNode)
  if (!extension) return false
  const sourceNode = mapEntryValue(extension, 'source')
  if (!isMap(sourceNode)) return false
  const buildKind = scalarString(mapEntryValue(sourceNode as YAMLMap, 'buildKind'))
  return buildKind?.trim() === 'railpack'
}

/**
 * Locate `x-turbopanel.source.sourceId` on a service node so the resolution
 * check can report the author's own line number.
 */
function serviceSourceIdNode(
  valueNode: YAMLMap,
): { sourceId: string | null; node: Node | null } | null {
  const extension = serviceExtensionMap(valueNode)
  if (!extension) return null
  const sourceNode = mapEntryValue(extension, 'source')
  if (sourceNode === undefined) return null
  if (!isMap(sourceNode)) return { sourceId: null, node: sourceNode }
  const idNode = mapEntryValue(sourceNode as YAMLMap, 'sourceId')
  if (idNode === undefined) return { sourceId: null, node: sourceNode as Node }
  return { sourceId: scalarString(idNode), node: idNode }
}

/**
 * `x-turbopanel.source` checks: an advisory that the block is inert this phase,
 * plus a blocking error when the id does not resolve for the organization.
 */
function lintServiceSource(
  name: string,
  valueNode: YAMLMap,
  known: KnownComposeReferences,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  const found = serviceSourceIdNode(valueNode)
  if (!found) return

  const path = `services.${name}.x-turbopanel.source.sourceId`
  const line = nodeLine(found.node, lineCounter)

  issues.push({
    level: 'warning',
    message: SOURCE_INERT_ADVISORY,
    path: `services.${name}.x-turbopanel.source`,
    line,
    blocking: false,
  })

  const knownSourceIds = known.sourceIds
  if (!knownSourceIds || found.sourceId === null) return
  const sourceId = found.sourceId.trim()
  if (sourceId.length === 0 || knownSourceIds.has(sourceId)) return

  issues.push({
    level: 'error',
    message: `source '${sourceId}' was not found for this organization`,
    path,
    line,
  })
}

/**
 * `x-turbopanel.principal` must name an alias the document actually declares.
 *
 * Blocking, unlike the `source` advisory next door: an alias that resolves to
 * nothing is not an inert hint, it is a service with no account to run as, and
 * the only other place it surfaces is deploy-prepare — after the operator has
 * pressed Deploy.
 */
function lintServicePrincipal(
  name: string,
  valueNode: YAMLMap,
  known: KnownComposeReferences,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  const knownPrincipalAliases = known.principalAliases
  if (!knownPrincipalAliases) return
  const extension = serviceExtensionMap(valueNode)
  if (!extension) return
  const aliasNode = mapEntryValue(extension, 'principal')
  const alias = scalarString(aliasNode)
  if (alias === null) return
  const trimmed = alias.trim()
  if (trimmed.length === 0 || knownPrincipalAliases.has(trimmed)) return

  issues.push({
    level: 'error',
    message:
      `principal '${trimmed}' is not declared in this document's x-turbopanel.principals`,
    path: `services.${name}.x-turbopanel.principal`,
    line: nodeLine(aliasNode ?? undefined, lineCounter),
  })
}

/**
 * `x-turbopanel.hosting` checks.
 *
 * Two kinds of rule live here, and they are gated differently on purpose:
 *
 * - **Pure shape** — a route with no usable hostname, and `targetPort` on a
 *   `site` (whose engine port the daemon allocates). These run unconditionally
 *   because the answer is in the document.
 * - **Resolution** — `tls.certificateRef` and `bind.ipRef`. These run only when
 *   the caller supplied the matching set, exactly like `knownSourceIds`:
 *   omitted means *skipped*, never false-flagged, because a caller with no
 *   database reach must not turn "I could not check" into "this is wrong".
 *
 * Messages come from `./hosting-extension.ts`, which owns the block, so the
 * editor and the save-time validator cannot say two different things about one
 * rule.
 */
function lintServiceHosting(
  name: string,
  valueNode: YAMLMap,
  known: KnownComposeReferences,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  const extension = serviceExtensionMap(valueNode)
  if (!extension) return
  const hostingNode = mapEntryValue(extension, 'hosting')
  if (!isSeq(hostingNode)) return
  const serviceKind = scalarString(mapEntryValue(extension, 'serviceKind'))

  for (const [index, item] of (hostingNode as YAMLSeq).items.entries()) {
    if (!isMap(item)) continue
    lintHostingEntry({
      basePath: `services.${name}.x-turbopanel.hosting[${index}]`,
      entry: item as YAMLMap,
      serviceKind,
      known,
      lineCounter,
      issues,
    })
  }
}

/** `serviceKind` as authored, narrowed for the kind-gated hosting rules. */
function hostingServiceKind(
  serviceKind: string | null,
): ComposeServiceKind | undefined {
  const trimmed = serviceKind?.trim()
  if (trimmed === 'site' || trimmed === 'node' || trimmed === 'container') {
    return trimmed
  }
  return undefined
}

function lintHostingEntry(params: {
  basePath: string
  entry: YAMLMap
  serviceKind: string | null
  known: KnownComposeReferences
  lineCounter: LineCounter
  issues: ComposeLintIssue[]
}): void {
  const { basePath, entry, serviceKind, known, lineCounter, issues } = params

  const hostnameNode = mapEntryValue(entry, 'hostname')
  if (!readHostingHostname(scalarString(hostnameNode))) {
    issues.push({
      level: 'error',
      message: HOSTING_HOSTNAME_REQUIRED_MESSAGE,
      path: `${basePath}.hostname`,
      line: nodeLine(hostnameNode ?? (entry as Node), lineCounter),
    })
  }

  const targetPortNode = mapEntryValue(entry, 'targetPort')
  if (
    targetPortNode !== undefined &&
    !hostingTargetPortAuthorable(hostingServiceKind(serviceKind))
  ) {
    issues.push({
      level: 'error',
      message: serviceKind === 'site'
        ? HOSTING_TARGET_PORT_NOT_FOR_SITE_MESSAGE
        : HOSTING_TARGET_PORT_NOT_FOR_NODE_MESSAGE,
      path: `${basePath}.targetPort`,
      line: nodeLine(targetPortNode ?? (entry as Node), lineCounter),
    })
  }

  // `automatic` parses, so without this the editor would bless a document
  // deploy-prepare refuses — the one thing a linter must never do.
  const tlsModeNode = nestedEntryValue(entry, 'tls', 'mode')
  if (scalarString(tlsModeNode)?.trim() === 'automatic') {
    issues.push({
      level: 'error',
      message: HOSTING_TLS_MODE_AUTOMATIC_UNSUPPORTED_MESSAGE,
      path: `${basePath}.tls.mode`,
      line: nodeLine(tlsModeNode ?? (entry as Node), lineCounter),
    })
  }

  lintHostingRef({
    path: `${basePath}.tls.certificateRef`,
    refNode: nestedEntryValue(entry, 'tls', 'certificateRef'),
    resolvable: known.tlsIds,
    message: hostingTlsRefUnresolvedMessage,
    lineCounter,
    issues,
  })
  lintHostingRef({
    path: `${basePath}.bind.ipRef`,
    refNode: nestedEntryValue(entry, 'bind', 'ipRef'),
    resolvable: known.ipIds,
    message: hostingIpRefUnresolvedMessage,
    lineCounter,
    issues,
  })
}

/** `entry.<block>.<key>` when both levels are maps, else undefined. */
function nestedEntryValue(
  entry: YAMLMap,
  block: string,
  key: string,
): Node | null | undefined {
  const blockNode = mapEntryValue(entry, block)
  if (!isMap(blockNode)) return undefined
  return mapEntryValue(blockNode as YAMLMap, key)
}

function lintHostingRef(params: {
  path: string
  refNode: Node | null | undefined
  resolvable: ReadonlySet<string> | undefined
  message: (ref: string) => string
  lineCounter: LineCounter
  issues: ComposeLintIssue[]
}): void {
  const { path, refNode, resolvable, message, lineCounter, issues } = params
  if (!resolvable) return
  const raw = scalarString(refNode)
  if (raw === null) return
  const ref = raw.trim()
  if (ref.length === 0 || resolvable.has(ref)) return
  issues.push({
    level: 'error',
    message: message(ref),
    path,
    line: nodeLine(refNode ?? undefined, lineCounter),
  })
}

/**
 * Advisory when `x-turbopanel.nodeVersion` pins a series this control plane
 * does not offer. Non-blocking on purpose: the authoritative answer is the
 * host's reported inventory, and the schema accepts any pinned version.
 */
function lintServiceNodeVersion(
  name: string,
  valueNode: YAMLMap,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  const extension = serviceExtensionMap(valueNode)
  if (!extension) return
  const versionNode = mapEntryValue(extension, 'nodeVersion')
  const version = scalarString(versionNode)
  if (version === null) return
  const series = version.trim().split('.')[0]
  if (series.length === 0 || SUPPORTED_NODE_SERIES.includes(series)) return
  issues.push({
    level: 'warning',
    message: `Node ${version} is not an offered series (${
      SUPPORTED_NODE_SERIES.join(', ')
    }); the deploy uses whatever the host has vendored`,
    path: `services.${name}.x-turbopanel.nodeVersion`,
    line: nodeLine(versionNode ?? undefined, lineCounter),
    blocking: false,
  })
}

function pushBaseTagAdvisory(
  node: Node | null | undefined,
  path: string,
  layer: 'base' | 'overlay',
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (layer !== 'base' || !isTaggedNode(node)) return
  issues.push({
    level: 'warning',
    message: BASE_LAYER_TAG_ADVISORY,
    path,
    line: nodeLine(node, lineCounter),
    blocking: false,
  })
}

/**
 * Walk a value tree and emit base-layer tag advisories; skip unknown-key walks
 * inside tagged sub-trees (a tagged node is intentional, not a typo).
 */
function walkTaggedAdvisories(
  node: Node | null | undefined,
  path: string,
  layer: 'base' | 'overlay',
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (!node || typeof node !== 'object') return
  if (isTaggedNode(node)) {
    pushBaseTagAdvisory(node, path, layer, lineCounter, issues)
    return
  }
  if (!isMap(node)) return
  for (const item of node.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    const childPath = path ? `${path}.${key}` : key
    walkTaggedAdvisories(
      item.value as Node | null | undefined,
      childPath,
      layer,
      lineCounter,
      issues,
    )
  }
}

/** Whether a service field lint pass found an `image` / `build` key. */
type ServiceFieldPresence = { hasImage: boolean; hasBuild: boolean }

/**
 * Lint a single service field (unknown-key check + nested tag advisories) and
 * report whether it counts toward the service's `image`/`build` requirement.
 */
function lintServiceField(
  servicePath: string,
  key: string,
  keyNode: Node | null | undefined,
  valueNode: Node | null | undefined,
  layer: 'base' | 'overlay',
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): ServiceFieldPresence {
  const fieldPath = `${servicePath}.${key}`

  // Tagged subtree is intentional — skip unknown-key checks inside it. Tagged
  // image/build fields still count as present for the structural requirement
  // (an override still supplies a value; a reset is an explicit author choice).
  if (isTaggedNode(valueNode)) {
    pushBaseTagAdvisory(valueNode, fieldPath, layer, lineCounter, issues)
    return { hasImage: key === 'image', hasBuild: key === 'build' }
  }

  const hasImage = key === 'image' && !isEmptyImageValue(valueNode)
  const hasBuild = key === 'build'

  if (classifyServiceKey(key) === undefined && !isExtensionKey(key)) {
    issues.push({
      level: 'warning',
      message: unknownKeyMessage(key, 'service', SERVICE_FIELD_KEYS),
      path: fieldPath,
      line: nodeLine(keyNode, lineCounter),
    })
  } else {
    // Nested advisories (e.g. healthcheck.test tagged).
    walkTaggedAdvisories(valueNode, fieldPath, layer, lineCounter, issues)
  }

  if (key === 'environment') {
    lintEnvOrArgsCollection(fieldPath, valueNode, lineCounter, issues)
  } else if (key === 'build') {
    lintBuildArgs(fieldPath, valueNode, lineCounter, issues)
  }

  return { hasImage, hasBuild }
}

function lintVariableRefScalar(
  raw: string,
  path: string,
  node: Node | null | undefined,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  const parsed = parseExactVariableRef(raw)
  if (parsed.ok || parsed.error === 'not_a_ref') return
  issues.push({
    level: 'error',
    message: parsed.message,
    path,
    line: nodeLine(node, lineCounter),
  })
}

function envSeqValueAfterSeparator(raw: string): string {
  const eq = raw.indexOf('=')
  const colon = raw.indexOf(':')
  if (eq < 0 && colon < 0) return ''
  if (eq < 0) return raw.slice(colon + 1)
  if (colon < 0) return raw.slice(eq + 1)
  return raw.slice(Math.min(eq, colon) + 1)
}

function lintEnvOrArgsMap(
  fieldPath: string,
  valueNode: YAMLMap,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  for (const item of valueNode.items) {
    const key = stringKey(item.key)
    const raw = scalarString(item.value as Node)
    if (key === null || raw === null) continue
    lintVariableRefScalar(
      raw,
      `${fieldPath}.${key}`,
      item.value as Node,
      lineCounter,
      issues,
    )
  }
}

function lintEnvOrArgsSeq(
  fieldPath: string,
  valueNode: YAMLSeq,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  for (const [index, item] of valueNode.items.entries()) {
    const raw = scalarString(item as Node)
    if (raw === null) continue
    lintVariableRefScalar(
      envSeqValueAfterSeparator(raw),
      `${fieldPath}[${index}]`,
      item as Node,
      lineCounter,
      issues,
    )
  }
}

function lintEnvOrArgsCollection(
  fieldPath: string,
  valueNode: Node | null | undefined,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (!valueNode || typeof valueNode !== 'object') return
  if (isMap(valueNode)) {
    lintEnvOrArgsMap(fieldPath, valueNode, lineCounter, issues)
    return
  }
  if (isSeq(valueNode)) {
    lintEnvOrArgsSeq(fieldPath, valueNode, lineCounter, issues)
  }
}

function lintBuildArgs(
  fieldPath: string,
  valueNode: Node | null | undefined,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (!isMap(valueNode)) return
  for (const item of valueNode.items) {
    if (stringKey(item.key) !== 'args') continue
    lintEnvOrArgsCollection(
      `${fieldPath}.args`,
      item.value as Node | null | undefined,
      lineCounter,
      issues,
    )
  }
}

/**
 * `deploy.replicas` values the scheduler cannot honour.
 *
 * The vendored Compose Specification types this field `integer | string` and
 * stops there — `0`, `-3` and `"two"` are all schema-valid Compose. But
 * `resolveReplicaPolicy` (`lib/schedule/interpret.ts`) only accepts a whole
 * number of at least one and otherwise *falls back* to `service.options.instances`
 * or to `1`, so a document asking for `replicas: 0` would deploy one replica
 * and say nothing. That is a materially different deployment than the author
 * asked for, which is the failure this pipeline exists to end — so the value is
 * refused here rather than silently replaced.
 *
 * Deliberately narrow, to keep one voice per path: values of the wrong *type*
 * (a float, a boolean, a sequence) are the upstream schema's to report, and are
 * left alone here. `mode: global` is skipped because the replica count is not
 * the author's to choose in that mode.
 */
function lintDeployReplicas(
  name: string,
  deployNode: YAMLMap,
  valueNode: Node | null | undefined,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (isTaggedNode(valueNode) || valueNode === null || valueNode === undefined) return
  if (isMap(valueNode) || isSeq(valueNode)) return
  if (scalarString(mapEntryValue(deployNode, 'mode')) === 'global') return

  const value = scalarValueOf(valueNode)
  if (typeof value === 'number') {
    // A non-integer is the schema's to report.
    if (!Number.isInteger(value) || value >= 1) return
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    // A placeholder stands for a value no linter can see; `apply-variables.ts`
    // substitutes it, and the compiled document is checked after that.
    if (trimmed.includes('${') || trimmed.includes('{$')) return
    if (/^\d+$/.test(trimmed) && Number.parseInt(trimmed, 10) >= 1) return
  } else {
    return
  }

  issues.push({
    level: 'error',
    message:
      'deploy.replicas must be a whole number of at least 1 \u2014 TurboPanel would otherwise ignore it and run a different number of replicas than this document asks for',
    path: `services.${name}.deploy.replicas`,
    line: nodeLine(valueNode, lineCounter),
  })
}

/**
 * `deploy.mode` values naming a controller TurboPanel does not have.
 *
 * The vendored Compose Specification types `mode` as a bare string, so Swarm's
 * two **job** modes are schema-valid Compose. Their whole meaning is that the
 * work is *finite*: tasks run to completion and the service is then done.
 * TurboPanel schedules long-running `slot` rows and restarts what exits, and
 * `parseDeployMode` (`lib/schedule/interpret.ts`) folds every non-`global`
 * value into `replicated` — so a job mode would deploy a service that never
 * finishes and never reports completion, which is a materially different thing
 * from what the document asks for.
 *
 * Refused by **value**, not by key: `mode` itself is honoured, so
 * `./field-policy.ts` keeps it `interpreted` + `strip` and the refusal is
 * raised here instead. Deliberately narrow for the same reason
 * {@link lintDeployReplicas} is — any *other* unrecognized value is the
 * upstream schema's to judge, not this rule's.
 */
const UNSUPPORTED_DEPLOY_MODES: ReadonlySet<string> = new Set([
  'replicated-job',
  'global-job',
])

function lintDeployMode(
  name: string,
  valueNode: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (isTaggedNode(valueNode)) return
  const value = scalarString(valueNode)?.trim()
  if (value === undefined || !UNSUPPORTED_DEPLOY_MODES.has(value)) return

  issues.push({
    level: strict ? 'error' : 'warning',
    code: 'field_unsupported',
    message:
      `deploy.mode: ${value} is not supported by TurboPanel \u2014 replicated-job and ` +
      'global-job need a finite-job controller with completion semantics, and ' +
      'TurboPanel schedules long-running replicas it restarts when they exit',
    path: `services.${name}.deploy.mode`,
    line: nodeLine(valueNode, lineCounter),
    // Save-time keeps a draft editable; deploy-time refuses it.
    ...(strict ? {} : { blocking: false as const }),
  })
}

/**
 * `deploy.restart_policy` values a generated systemd unit cannot express.
 *
 * A `serviceKind: node` service is pulled out of the compose document entirely
 * and supervised by `turbopanel-app-<serviceId>.service`, so this key is the
 * one lane where Docker never reads it and only a *translation* could honour
 * it: `condition` to `Restart=`, `delay` to `RestartSec=`, `max_attempts` to
 * `StartLimitBurst=`, `window` to `StartLimitIntervalSec=`. Values outside that
 * vocabulary are refused here rather than dropped on the way through
 * `readNativeAppRestartPolicy` (`./native-app.ts`), which would leave the
 * author with no diagnostic anywhere.
 *
 * `max_attempts: 0` is the sharpest case and the reason this is a refusal
 * rather than a clamp: `StartLimitBurst=0` means *no* rate limit to systemd,
 * the exact opposite of "do not retry".
 *
 * Container services are untouched — Docker reads the whole Compose vocabulary
 * itself, and narrowing it there would refuse documents that work.
 */
function nativeRestartExpectation(key: string, value: unknown): string | null {
  if (key === 'condition') {
    if (isNativeAppRestartCondition(value)) return null
    return `must be one of ${[...NATIVE_APP_RESTART_CONDITIONS].join(', ')}`
  }
  if (key === 'delay' || key === 'window') {
    if (isNativeAppRestartDuration(value)) return null
    return 'must be a Compose duration such as 5s or 1m30s'
  }
  if (key === 'max_attempts') {
    if (isNativeAppRestartMaxAttempts(value)) return null
    return 'must be a whole number of at least 1 \u2014 0 would render as StartLimitBurst=0, which systemd reads as no rate limit at all, the opposite of "do not retry"'
  }
  return null
}

function lintNativeRestartPolicyField(
  name: string,
  key: string,
  valueNode: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (isTaggedNode(valueNode)) return
  if (valueNode === null || valueNode === undefined) return
  if (isMap(valueNode) || isSeq(valueNode)) return

  const value = scalarValueOf(valueNode)
  // A placeholder stands for a value no linter can see; `apply-variables.ts`
  // substitutes it and the compiled document is checked after that.
  if (
    typeof value === 'string' &&
    (value.includes('${') || value.includes('{$'))
  ) {
    return
  }

  const expectation = nativeRestartExpectation(key, value)
  if (expectation === null) return

  issues.push({
    level: strict ? 'error' : 'warning',
    code: 'field_unsupported',
    message:
      `deploy.restart_policy.${key} is not supported by TurboPanel on a ` +
      `serviceKind: node service \u2014 the generated systemd unit ${expectation}`,
    path: `services.${name}.deploy.restart_policy.${key}`,
    line: nodeLine(valueNode, lineCounter),
    // Save-time keeps a draft editable; deploy-time refuses it.
    ...(strict ? {} : { blocking: false as const }),
  })
}

function lintNativeRestartPolicy(
  name: string,
  restartPolicyNode: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (!isMap(restartPolicyNode) || isTaggedNode(restartPolicyNode)) return
  for (const item of (restartPolicyNode as YAMLMap).items) {
    const key = stringKey(item.key)
    if (key === null || isExtensionKey(key)) continue
    lintNativeRestartPolicyField(
      name,
      key,
      item.value as Node | null | undefined,
      strict,
      lineCounter,
      issues,
    )
  }
}

/**
 * Classify every key under `services.<name>.deploy.resources`.
 *
 * The parent `resources` key is passthrough — both engines act on
 * `limits` — so the per-key pass over `deploy:` says nothing about it, and the
 * one sub-key TurboPanel cannot honour would sail through with it.
 *
 * `reservations` is a scheduler admission requirement and there is no per-host
 * capacity inventory to admit against, so a reserving service would be placed
 * exactly as if the block were absent. Reported here rather than silently
 * carried: a deploy that succeeded would have told the operator the placement
 * respected the reservation.
 */
function lintDeployResources(
  name: string,
  resourcesNode: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (!isMap(resourcesNode) || isTaggedNode(resourcesNode)) return

  for (const item of (resourcesNode as YAMLMap).items) {
    const key = stringKey(item.key)
    if (key === null || isExtensionKey(key)) continue
    if (classifyDeployResourcesKey(key)?.state !== 'unsupported') continue
    const reason = unsupportedDeployResourcesReason(key)
    issues.push({
      level: strict ? 'error' : 'warning',
      code: 'field_unsupported',
      message: `deploy.resources.${key} is not supported by TurboPanel${
        reason ? ` \u2014 ${reason}` : ''
      }`,
      path: `services.${name}.deploy.resources.${key}`,
      line: nodeLine(item.key as Node, lineCounter),
      // Save-time keeps a draft editable; deploy-time refuses it.
      ...(strict ? {} : { blocking: false as const }),
    })
  }
}

/**
 * Classify every key under `services.<name>.deploy` through
 * `./field-policy.ts`.
 *
 * `passthrough` and `interpreted` keys pass in silence — the registry says
 * something happens with them, and the author does not need to hear about a
 * field that works. `unsupported` is the whole point of the pass: before the
 * registry existed, `update_config` / `rollback_config` / `endpoint_mode` were
 * deleted from the compiled runtime document by a set in `compile-runtime.ts`
 * that emitted nothing, so the deploy ignored them and said so nowhere.
 *
 * An *unknown* key is not reported here. The vendored Compose Specification
 * (`./upstream-schema.ts`) already closes this object, so reporting it twice
 * would put two different sentences on one line.
 *
 * Four keys are also checked below the key level, because for them the
 * registry's per-key verdict is not the whole answer — a supported key can
 * still be given a value, or a sub-key, this platform would quietly turn into
 * something else: {@link lintDeployReplicas}, {@link lintDeployMode},
 * {@link lintDeployResources} and, on the native lane only,
 * {@link lintNativeRestartPolicy}.
 *
 * Severity is the caller's: see {@link ComposeLintOptions.strict}.
 */
function lintUnsupportedDeployKey(
  name: string,
  key: string,
  keyNode: Node,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (classifyDeployKey(key)?.state !== 'unsupported') return
  const reason = unsupportedDeployReason(key)
  issues.push({
    level: strict ? 'error' : 'warning',
    code: 'field_unsupported',
    message: `deploy.${key} is not supported by TurboPanel${
      reason ? ` \u2014 ${reason}` : ''
    }`,
    path: `services.${name}.deploy.${key}`,
    line: nodeLine(keyNode, lineCounter),
    // Save-time keeps a draft editable; deploy-time refuses it.
    ...(strict ? {} : { blocking: false as const }),
  })
}

function lintDeployBlock(
  name: string,
  deployNode: Node | null | undefined,
  nativeApp: boolean,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  // A tagged `deploy:` is an overlay instruction; the merged result is linted
  // where the merge happens.
  if (!isMap(deployNode) || isTaggedNode(deployNode)) return

  for (const item of (deployNode as YAMLMap).items) {
    const key = stringKey(item.key)
    if (key === null || isExtensionKey(key)) continue
    if (key === 'replicas') {
      lintDeployReplicas(
        name,
        deployNode as YAMLMap,
        item.value as Node | null | undefined,
        lineCounter,
        issues,
      )
    } else if (key === 'mode') {
      lintDeployMode(
        name,
        item.value as Node | null | undefined,
        strict,
        lineCounter,
        issues,
      )
    } else if (key === 'resources') {
      lintDeployResources(
        name,
        item.value as Node | null | undefined,
        strict,
        lineCounter,
        issues,
      )
    } else if (key === 'restart_policy' && nativeApp) {
      lintNativeRestartPolicy(
        name,
        item.value as Node | null | undefined,
        strict,
        lineCounter,
        issues,
      )
    }
    lintUnsupportedDeployKey(
      name,
      key,
      item.key as Node,
      strict,
      lineCounter,
      issues,
    )
  }
}

/**
 * The advisory every `driver: overlay` network carries.
 *
 * The linter is pure — no database — so it cannot see whether the organization
 * has TurboFabric enabled, and the same contract every db-backed rule here uses
 * applies: a check it cannot answer is not one it may fail. The real refusal is
 * `turbofabric_required` in `lib/schedule/planner.ts`, which has the fabric row
 * in hand; this is the note that says what the driver value now means, while
 * there is still time to change it.
 */
const TURBOFABRIC_OVERLAY_ADVISORY =
  'driver: overlay makes this a TurboFabric spanning network \u2014 the organization needs TurboFabric enabled before an environment can join it across more than one server'

/**
 * Classify every key under one top-level `networks.<key>` entry.
 *
 * Scoped to overlay-declared networks on purpose. A `bridge` or default network
 * is handed to Docker whole, and `./field-policy.ts` keeps every attribute
 * `passthrough` for it — flagging `ipam` there would refuse documents that work
 * today. A network declared `driver: overlay` is the one TurboPanel
 * *substitutes*: it becomes a `network(kind='compose')` row whose per-host
 * segments compile to `external: true` + `name: tpn_<networkId>`, so the five
 * attributes an overlay driver would have read — `internal` among them — have
 * nothing left to read them.
 * Before this pass they were accepted and silently did nothing.
 *
 * Severity is the caller's: see {@link ComposeLintOptions.strict}.
 */
function lintNetworkEntry(
  key: string,
  entryNode: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  // A tagged entry is an overlay instruction; the merged result is linted where
  // the merge happens.
  if (!isMap(entryNode) || isTaggedNode(entryNode)) return

  const driverNode = mapEntryValue(entryNode as YAMLMap, 'driver')
  const driver = scalarString(driverNode)?.trim()
  if (driver !== SPANNING_NETWORK_DRIVER) return

  issues.push({
    level: 'warning',
    code: 'turbofabric_required',
    message: `networks.${key}.${TURBOFABRIC_OVERLAY_ADVISORY}`,
    path: `networks.${key}.driver`,
    line: nodeLine(driverNode as Node, lineCounter),
    // Never a refusal from here: the linter cannot see the fabric row.
    blocking: false,
  })

  for (const item of (entryNode as YAMLMap).items) {
    const field = stringKey(item.key)
    if (field === null || isExtensionKey(field)) continue
    if (classifyNetworkKey(field, driver)?.state !== 'unsupported') continue
    const reason = unsupportedNetworkReason(field, driver)
    const reasonSuffix = reason ? ` \u2014 ${reason}` : ''
    issues.push({
      level: strict ? 'error' : 'warning',
      code: 'field_unsupported',
      message:
        `networks.${key}.${field} is not supported by TurboPanel on a ` +
        `driver: overlay network${reasonSuffix}`,
      path: `networks.${key}.${field}`,
      line: nodeLine(item.key as Node, lineCounter),
      // Save-time keeps a draft editable; deploy-time refuses it.
      ...(strict ? {} : { blocking: false as const }),
    })
  }
}

/** Run {@link lintNetworkEntry} over every top-level `networks:` entry. */
function lintNetworks(
  networksNode: Node | null | undefined,
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (!isMap(networksNode) || isTaggedNode(networksNode)) return
  for (const item of (networksNode as YAMLMap).items) {
    const key = stringKey(item.key)
    if (key === null || isExtensionKey(key)) continue
    lintNetworkEntry(
      key,
      item.value as Node | null | undefined,
      strict,
      lineCounter,
      issues,
    )
  }
}

function lintService(params: {
  name: string
  valueNode: Node | null | undefined
  keyLine: number | undefined
  lineCounter: LineCounter
  layer: 'base' | 'overlay'
  strict: boolean
  known: KnownComposeReferences
  issues: ComposeLintIssue[]
}): void {
  const { name, valueNode, keyLine, lineCounter, layer, strict, known, issues } = params
  const path = `services.${name}`

  // Whole service body tagged — skip structural checks; still advisory on base.
  if (isTaggedNode(valueNode)) {
    pushBaseTagAdvisory(valueNode, path, layer, lineCounter, issues)
    return
  }

  if (!isMap(valueNode)) {
    issues.push({
      level: 'error',
      message: `Service "${name}" must be a mapping`,
      path,
      line: keyLine,
    })
    return
  }

  let hasImage = false
  let hasBuild = false
  for (const item of valueNode.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    const presence = lintServiceField(
      path,
      key,
      item.key as Node,
      item.value as Node | null | undefined,
      layer,
      lineCounter,
      issues,
    )
    hasImage = hasImage || presence.hasImage
    hasBuild = hasBuild || presence.hasBuild
  }

  lintDeployBlock(
    name,
    mapEntryValue(valueNode, 'deploy'),
    serviceIsNativeApp(valueNode),
    strict,
    lineCounter,
    issues,
  )
  lintServiceSource(name, valueNode, known, lineCounter, issues)
  lintServicePrincipal(name, valueNode, known, lineCounter, issues)
  lintServiceHosting(name, valueNode, known, lineCounter, issues)
  lintServiceNodeVersion(name, valueNode, lineCounter, issues)

  const hostNative = serviceIsHostNative(valueNode)
  const railpackBuilt = serviceIsRailpackBuilt(valueNode)
  if (!hostNative && !railpackBuilt && !hasImage && !hasBuild) {
    issues.push({
      level: 'error',
      message: `Service "${name}" must define "image" or "build"`,
      path,
      line: keyLine,
    })
  }
}

function lintServices(
  servicesNode: Node | null | undefined,
  servicesKeyLine: number | undefined,
  lineCounter: LineCounter,
  layer: 'base' | 'overlay',
  strict: boolean,
  known: KnownComposeReferences,
  issues: ComposeLintIssue[],
): void {
  if (isTaggedNode(servicesNode)) {
    pushBaseTagAdvisory(servicesNode, 'services', layer, lineCounter, issues)
    return
  }

  if (!isMap(servicesNode)) {
    issues.push({
      level: 'error',
      message: '"services" must be a mapping',
      path: 'services',
      line: servicesKeyLine,
    })
    return
  }

  if (servicesNode.items.length === 0) {
    issues.push({
      level: 'warning',
      message: 'No services defined',
      path: 'services',
      line: servicesKeyLine,
    })
    return
  }

  for (const item of servicesNode.items) {
    const name = stringKey(item.key)
    if (name === null) continue
    lintService({
      name,
      valueNode: item.value as Node | null | undefined,
      keyLine: nodeLine(item.key as Node, lineCounter),
      lineCounter,
      layer,
      strict,
      known,
      issues,
    })
  }
}

function lintTopLevelEntry(
  key: string,
  keyNode: Node,
  valueNode: Node | null | undefined,
  layer: 'base' | 'overlay',
  strict: boolean,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (key === 'networks') {
    lintNetworks(valueNode, strict, lineCounter, issues)
  }
  if (classifyTopLevelKey(key) === undefined && !isExtensionKey(key)) {
    issues.push({
      level: 'warning',
      message: unknownKeyMessage(key, 'top-level', TOP_LEVEL_FIELD_KEYS),
      path: key,
      line: nodeLine(keyNode, lineCounter),
    })
  } else {
    walkTaggedAdvisories(valueNode, key, layer, lineCounter, issues)
  }
}

function lintTopLevel(
  root: YAMLMap,
  lineCounter: LineCounter,
  layer: 'base' | 'overlay',
  strict: boolean,
  known: KnownComposeReferences,
  issues: ComposeLintIssue[],
): void {
  let servicesItem: (typeof root.items)[number] | null = null
  for (const item of root.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    const valueNode = item.value as Node | null | undefined
    if (isTaggedNode(valueNode)) {
      pushBaseTagAdvisory(valueNode, key, layer, lineCounter, issues)
      if (key === 'services') servicesItem = item
      continue
    }
    if (key === 'services') {
      servicesItem = item
      continue
    }
    lintTopLevelEntry(
      key,
      item.key as Node,
      valueNode,
      layer,
      strict,
      lineCounter,
      issues,
    )
  }

  if (!servicesItem) {
    issues.push({
      level: 'warning',
      message: 'Compose file has no "services" section',
      path: '$',
    })
    return
  }

  lintServices(
    servicesItem.value as Node | null | undefined,
    nodeLine(servicesItem.key as Node, lineCounter),
    lineCounter,
    layer,
    strict,
    known,
    issues,
  )
}

/** Sort by source line (ascending); lineless last; errors before warnings on a tie. */
function compareLintIssues(a: ComposeLintIssue, b: ComposeLintIssue): number {
  const lineA = a.line ?? Number.POSITIVE_INFINITY
  const lineB = b.line ?? Number.POSITIVE_INFINITY
  if (lineA !== lineB) {
    return lineA - lineB
  }
  if (a.level !== b.level) {
    return a.level === 'error' ? -1 : 1
  }
  return a.path.localeCompare(b.path)
}

/**
 * Collect every `x-turbopanel.source.sourceId` in the document, in file order.
 *
 * A second walk rather than another parameter threaded through `lintServices` →
 * `lintService` → `lintServiceSource`: this rule is about the document as a
 * whole, and the per-service walk has no place to hold "what did the other
 * services say".
 */
function collectServiceSourceIds(
  root: YAMLMap,
  lineCounter: LineCounter,
): { service: string; sourceId: string; line: number | undefined }[] {
  const servicesNode = mapEntryValue(root, 'services')
  if (!isMap(servicesNode)) return []
  const found: { service: string; sourceId: string; line: number | undefined }[] = []
  for (const item of servicesNode.items) {
    const service = stringKey(item.key)
    if (service === null) continue
    const valueNode = item.value as Node | null | undefined
    if (!isMap(valueNode)) continue
    // Takes the *service* map: the extension lookup is its own first step.
    const entry = serviceSourceIdNode(valueNode as YAMLMap)
    if (!entry?.sourceId) continue
    const sourceId = entry.sourceId.trim()
    if (sourceId.length === 0) continue
    found.push({ service, sourceId, line: nodeLine(entry.node, lineCounter) })
  }
  return found
}

/**
 * One repository per project.
 *
 * Flags the *second* distinct id and every one after it, never the first: the
 * first is the project's repository (already bound, or adopted by this very
 * save), so pointing at it as the offender would tell the operator to remove
 * the binding they actually want. When the project is already bound, an id that
 * is not that one is the offender no matter where it appears.
 */
function lintSingleRepository(
  root: YAMLMap,
  lineCounter: LineCounter,
  projectRepositoryId: string | null,
  issues: ComposeLintIssue[],
): void {
  const bound = projectRepositoryId?.trim() || null
  let adopted = bound
  for (const entry of collectServiceSourceIds(root, lineCounter)) {
    if (adopted === null) {
      adopted = entry.sourceId
      continue
    }
    if (entry.sourceId === adopted) continue
    issues.push({
      level: 'error',
      message: bound === null
        ? 'a project builds from one repository — every service that names a source must name the same one'
        : `source '${entry.sourceId}' is not this project's repository — a project builds from one repository`,
      path: `services.${entry.service}.x-turbopanel.source.sourceId`,
      line: entry.line,
    })
  }
}

/**
 * Merge the upstream-schema stage into the semantic stage's findings.
 *
 * One path, one sentence. Where both stages have something to say about the
 * same location the semantic issue wins, because it is the one that can offer
 * a "did you mean", name the field's state, or explain what TurboPanel does
 * instead — a bare schema violation is the weaker of the two answers.
 */
function mergeSchemaIssues(
  schemaIssues: readonly ComposeLintIssue[],
  semanticIssues: readonly ComposeLintIssue[],
): ComposeLintIssue[] {
  const spoken = new Set(semanticIssues.map((issue) => issue.path))
  return [
    ...semanticIssues,
    ...schemaIssues.filter((issue) => !spoken.has(issue.path)),
  ]
}

/**
 * Lint docker-compose YAML for structural mistakes (invalid YAML, unknown keys,
 * services missing image/build). Returns an empty list for empty input. Issues
 * are ordered by line number.
 *
 * Two stages, in this order:
 *
 * 1. **Upstream Compose Specification** (`./upstream-schema.ts`) — the vendored,
 *    pinned schema. "Is this a Compose file at all", answered before anything
 *    about TurboPanel.
 * 2. **Semantic rules** — this module: unknown keys against `./field-policy.ts`,
 *    `image`/`build` requirements, `x-turbopanel` reference resolution, overlay
 *    tag advisories, and the `deploy:` / `networks:` field-state passes.
 *
 * The extension schema (`validateComposeDocument` in `./validate.ts`) sits
 * between them for callers that hold a stored `ComposeDocument`; a caller with
 * only YAML gets stages 1 and 2. Deploy-time strictness is stage 4 and lives in
 * `./validate-for-deploy.ts`.
 */
export function lintComposeYaml(
  source: string,
  options?: ComposeLintOptions,
): ComposeLintIssue[] {
  const layer = options?.layer ?? 'base'
  const known: KnownComposeReferences = {
    ...(options?.knownSourceIds ? { sourceIds: options.knownSourceIds } : {}),
    ...(options?.knownPrincipalAliases
      ? { principalAliases: options.knownPrincipalAliases }
      : {}),
    ...(options?.knownTlsIds ? { tlsIds: options.knownTlsIds } : {}),
    ...(options?.knownIpIds ? { ipIds: options.knownIpIds } : {}),
  }
  const trimmed = source.trim()
  if (!trimmed) return []

  const lineCounter = new LineCounter()
  const doc = parseDocument(source, {
    prettyErrors: true,
    lineCounter,
    ...COMPOSE_YAML_OPTIONS,
  })

  if (doc.errors.length > 0) {
    return doc.errors
      .map((error) => ({
        level: 'error' as const,
        message: error.message.split('\n')[0] ?? error.message,
        path: '$',
        line: error.linePos?.[0]?.line,
      }))
      .sort(compareLintIssues)
  }

  const root = doc.contents
  if (!isMap(root)) {
    return [
      {
        level: 'error',
        message: 'Compose file root must be a mapping',
        path: '$',
        line: nodeLine(root as Node, lineCounter),
      },
    ]
  }

  // Stage 1 — upstream Compose Specification, before any TurboPanel opinion.
  const schemaIssues = validateAgainstUpstreamSchema(root, lineCounter)

  // Stage 2 — TurboPanel's own semantics.
  const issues: ComposeLintIssue[] = []
  lintTopLevel(root, lineCounter, layer, options?.strict ?? false, known, issues)
  if (options?.projectRepositoryId !== undefined) {
    lintSingleRepository(root, lineCounter, options.projectRepositoryId, issues)
  }
  return mergeSchemaIssues(schemaIssues, issues).sort(compareLintIssues)
}

/**
 * Issues that must fail a save (everything except empty-draft warnings and
 * explicitly non-blocking advisories).
 */
export function blockingComposeLintIssues(
  issues: readonly ComposeLintIssue[],
): ComposeLintIssue[] {
  return issues.filter(
    (issue) =>
      issue.blocking !== false &&
      !DRAFT_ALLOWED_LINT_MESSAGES.has(issue.message),
  )
}
