import type { ComposeDocument } from './types.ts'
import {
  composeInterpolationRef,
  encodeEnvFile,
  type EnvFileEntry,
  serviceEnvInterpolationKey,
} from './env-file.ts'
import {
  buildSecretPlanEntry,
  DEFAULT_DEPLOY_RUN_DIR,
  type DeploySecretPlanEntry,
  secretContainerPath,
  secretFileEnvKey,
  secretHostPath,
} from './secret-files.ts'
import {
  collectComposeInterpolationKeys,
  type ParsedVariableRef,
  parseExactVariableRef,
  type VariableRefScope,
} from './variable-refs.ts'

export type DeployVariableEntry = {
  key: string
  value: string
  isSecret: boolean
  isLiteral: boolean
  forBuild: boolean
  forRuntime: boolean
  bindingId?: string | null
  /**
   * Where this value was set (a scope name, or `binding`). Informational: it
   * labels the list a service's owner sees and decides nothing at deploy.
   */
  source?: string
}

/** A runtime secret in a native app's resolved set that nothing passes to it. */
export type UnreferencedSecret = { key: string; source?: string }

/**
 * One environment variable a service's process ends up with, as this module
 * decided it — recorded so a lane that has no Compose `environment:` (a native
 * app) can be handed the same answer the Compose lane got.
 */
export type RuntimeEnvAssignment = {
  /** Name the process sees. Differs from `key` for `FOO: "{$BAR}"`. */
  name: string
  /** The variable the value comes from. */
  key: string
  isSecret: boolean
  /**
   * The plain value, trimmed and **not** Compose-escaped. `null` for a secret:
   * it travels sealed, never as a value this module holds.
   */
  value: string | null
  source?: string
}

export type DeployVariableMaterial = {
  key: string
  composeServiceName: string | null
  forBuild: boolean
  forRuntime: boolean
  isLiteral: boolean
  valueEnvelope: string
}

export type VariableScopeEntryMap = Partial<
  Record<VariableRefScope, Map<string, DeployVariableEntry>>
>

export type ApplyVariablesError = {
  kind: 'variable_unresolved' | 'variable_ref_invalid' | 'variable_secret_interpolation'
  message: string
  ref?: string
  composeServiceName?: string
  envKey?: string
}

export type ApplyVariablesResult = {
  document: ComposeDocument
  /** Secret values sealed for daemon delivery — never embed in compose YAML. */
  secretMaterial: DeployVariableMaterial[]
  secretPlan: DeploySecretPlanEntry[]
  envFileContent: string
  /** Runtime environment per compose service, in assignment order. */
  runtimeAssignments: Map<string, RuntimeEnvAssignment[]>
  /**
   * Runtime secrets a native app was **not** given because nothing references
   * them, per compose service — so the list the app's owner reads can say so
   * instead of leaving them out. Only filled for the services named in
   * `params.nativeServiceNames`.
   */
  unreferencedSecrets: Map<string, UnreferencedSecret[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trim leading/trailing whitespace; preserve internal newlines. */
export function trimVariableValue(value: string): string {
  return value.trim()
}

/** Escape `$` for Docker Compose so literal values are not interpolated. */
export function escapeLiteralComposeValue(value: string): string {
  return value.replaceAll('$', '$$$$')
}

/**
 * Parse one Compose list-form environment entry (`KEY=value`, `KEY:value`, or
 * bare `KEY`). Separator is the first `=` or `:` (Compose Spec duality).
 * Bare keys map to `''` so they remain in the string map used for injection.
 */
function parseListEnvEntry(item: string): { key: string; value: string } {
  const eq = item.indexOf('=')
  const colon = item.indexOf(':')
  let sep = -1
  if (eq >= 0 && colon >= 0) sep = Math.min(eq, colon)
  else if (eq >= 0) sep = eq
  else if (colon >= 0) sep = colon
  if (sep < 0) return { key: item, value: '' }
  return { key: item.slice(0, sep), value: item.slice(sep + 1) }
}

/**
 * Read mapping-form or list-form Compose `environment` / `build.args` into a
 * string map. List form (`KEY=value` / `KEY:value` / bare `KEY`) is normalized
 * so platform injection preserves user entries instead of dropping them.
 * Mapping form is unchanged (string values only).
 */
function readStringEnvMap(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const out: Record<string, string> = {}
    for (const item of value) {
      if (typeof item !== 'string') continue
      const { key, value: envValue } = parseListEnvEntry(item)
      out[key] = envValue
    }
    return out
  }
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue === 'string') out[key] = envValue
  }
  return out
}

function writeStringEnvMap(service: Record<string, unknown>, env: Record<string, string>): void {
  if (Object.keys(env).length === 0) {
    delete service.environment
    return
  }
  service.environment = env
}

function writeBuildArgs(service: Record<string, unknown>, args: Record<string, string>): void {
  if (!isRecord(service.build) && Object.keys(args).length === 0) return
  const build = isRecord(service.build) ? { ...service.build } : {}
  if (Object.keys(args).length === 0) {
    delete build.args
  } else {
    build.args = args
  }
  if (Object.keys(build).length === 0) delete service.build
  else service.build = build
}

function listComposeServiceNames(document: ComposeDocument): string[] {
  const services = document.data.services
  if (!isRecord(services)) return []
  return Object.keys(services).sort((a, b) => a.localeCompare(b))
}

function isPlatformInlineKey(key: string): boolean {
  return key.startsWith('TURBOPANEL_')
}

function entriesToMap(entries: readonly DeployVariableEntry[]): Map<string, DeployVariableEntry> {
  const map = new Map<string, DeployVariableEntry>()
  for (const entry of entries) map.set(entry.key, entry)
  return map
}

function lookupVariable(
  ref: ParsedVariableRef,
  inherited: Map<string, DeployVariableEntry>,
  scopes: VariableScopeEntryMap | undefined
): DeployVariableEntry | undefined {
  if (ref.scope) return scopes?.[ref.scope]?.get(ref.key)
  return inherited.get(ref.key)
}

function collectSecretKeys(
  inherited: Map<string, DeployVariableEntry>,
  scopes: VariableScopeEntryMap | undefined
): Set<string> {
  const keys = new Set<string>()
  for (const entry of inherited.values()) {
    if (entry.isSecret) keys.add(entry.key)
  }
  if (!scopes) return keys
  for (const map of Object.values(scopes)) {
    if (!map) continue
    for (const entry of map.values()) {
      if (entry.isSecret) keys.add(entry.key)
    }
  }
  return keys
}

function secretMaterialFrom(
  entry: DeployVariableEntry,
  composeServiceName: string
): DeployVariableMaterial {
  return {
    key: entry.key,
    composeServiceName,
    forBuild: entry.forBuild,
    forRuntime: entry.forRuntime,
    isLiteral: entry.isLiteral,
    valueEnvelope: entry.value,
  }
}

function ensureTopLevelSecret(
  data: Record<string, unknown>,
  plan: DeploySecretPlanEntry,
  hostPath: string
): void {
  const secrets = isRecord(data.secrets) ? { ...data.secrets } : {}
  secrets[plan.source] = { file: hostPath }
  data.secrets = secrets
}

// No `uid` / `gid` / `mode`: Docker Compose only supports them in Swarm mode and
// logs a warning on every deploy otherwise. The file's own host permissions apply.
function appendServiceSecret(service: Record<string, unknown>, plan: DeploySecretPlanEntry): void {
  const next = Array.isArray(service.secrets) ? [...service.secrets] : []
  const already = next.some((item) => {
    if (typeof item === 'string') return item === plan.source
    return isRecord(item) && item.source === plan.source
  })
  if (already) return
  next.push({
    source: plan.source,
    target: plan.target,
  })
  service.secrets = next
}

function appendBuildSecret(service: Record<string, unknown>, plan: DeploySecretPlanEntry): void {
  const build = isRecord(service.build) ? { ...service.build } : {}
  const next = Array.isArray(build.secrets) ? [...build.secrets] : []
  const already = next.some((item) => {
    if (typeof item === 'string') return item === plan.source
    return isRecord(item) && item.source === plan.source
  })
  if (!already) {
    next.push({ source: plan.source, target: plan.target })
    build.secrets = next
  }
  service.build = build
}

function applySecretMounts(
  service: Record<string, unknown>,
  data: Record<string, unknown>,
  plan: DeploySecretPlanEntry,
  hostPath: string,
  runtimeEnv: Record<string, string> | undefined
): void {
  ensureTopLevelSecret(data, plan, hostPath)
  if (plan.forRuntime) {
    appendServiceSecret(service, plan)
    if (runtimeEnv) {
      runtimeEnv[secretFileEnvKey(plan.target)] = secretContainerPath(plan.target)
    }
  }
  if (plan.forBuild) appendBuildSecret(service, plan)
}

type ApplyServiceState = {
  service: Record<string, unknown>
  data: Record<string, unknown>
  composeServiceName: string
  inherited: Map<string, DeployVariableEntry>
  scopes: VariableScopeEntryMap | undefined
  secretKeys: Set<string>
  plannedKeys: Set<string>
  secretMaterial: DeployVariableMaterial[]
  secretPlan: DeploySecretPlanEntry[]
  envEntries: EnvFileEntry[]
  runtimeAssignments: RuntimeEnvAssignment[]
  /** The service is a native (`serviceKind: node`) app — see {@link shouldAutoAttachSecret}. */
  nativeApp: boolean
  unreferencedSecrets: UnreferencedSecret[]
  projectId: string
  environmentId: string
  runDir: string
}

function interpolationFor(
  composeServiceName: string,
  variableKey: string
): { envKey: string; ref: string } {
  const envKey = serviceEnvInterpolationKey(composeServiceName, variableKey)
  return { envKey, ref: composeInterpolationRef(envKey) }
}

function applyNonSecretAssignment(
  state: ApplyServiceState,
  envKey: string,
  entry: DeployVariableEntry,
  target: 'runtime' | 'build',
  runtimeEnv: Record<string, string>,
  buildArgs: Record<string, string>
): void {
  if (target === 'runtime') {
    state.runtimeAssignments.push({
      name: envKey,
      key: entry.key,
      isSecret: false,
      value: trimVariableValue(entry.value),
      ...(entry.source === undefined ? {} : { source: entry.source }),
    })
  }
  if (isPlatformInlineKey(entry.key)) {
    const formatted = entry.isLiteral
      ? escapeLiteralComposeValue(trimVariableValue(entry.value))
      : trimVariableValue(entry.value)
    if (target === 'runtime') runtimeEnv[envKey] = formatted
    else buildArgs[envKey] = formatted
    return
  }
  const token = interpolationFor(state.composeServiceName, entry.key)
  state.envEntries.push({
    key: token.envKey,
    value: trimVariableValue(entry.value),
    isLiteral: entry.isLiteral,
  })
  if (target === 'runtime') runtimeEnv[envKey] = token.ref
  else buildArgs[envKey] = token.ref
}

function findPlannedSecret(
  state: ApplyServiceState,
  key: string
): DeploySecretPlanEntry | undefined {
  return state.secretPlan.find(
    (plan) => plan.key === key && plan.composeServiceName === state.composeServiceName
  )
}

function applySecretAssignment(
  state: ApplyServiceState,
  entry: DeployVariableEntry,
  runtimeEnv: Record<string, string> | undefined,
  envKey: string = entry.key
): void {
  const existing = findPlannedSecret(state, entry.key)
  if (existing) {
    const hostPath = secretHostPath(
      state.projectId,
      state.environmentId,
      existing.relativePath,
      state.runDir
    )
    if (entry.forBuild && !existing.forBuild) existing.forBuild = true
    if (entry.forRuntime && !existing.forRuntime) existing.forRuntime = true
    applySecretMounts(state.service, state.data, existing, hostPath, runtimeEnv)
    const material = state.secretMaterial.find(
      (row) => row.key === entry.key && row.composeServiceName === state.composeServiceName
    )
    if (material) {
      material.forBuild = existing.forBuild
      material.forRuntime = existing.forRuntime
    }
    return
  }
  state.plannedKeys.add(entry.key)
  const plan = buildSecretPlanEntry({
    key: entry.key,
    composeServiceName: state.composeServiceName,
    forBuild: entry.forBuild,
    forRuntime: entry.forRuntime,
    target: envKey,
  })
  const hostPath = secretHostPath(
    state.projectId,
    state.environmentId,
    plan.relativePath,
    state.runDir
  )
  applySecretMounts(state.service, state.data, plan, hostPath, runtimeEnv)
  state.secretPlan.push(plan)
  state.secretMaterial.push(secretMaterialFrom(entry, state.composeServiceName))
}

function unresolvedError(
  state: ApplyServiceState,
  ref: ParsedVariableRef,
  envKey: string
): ApplyVariablesError {
  const labeled = ref.scope ? `{$${ref.scope}.${ref.key}}` : `{$${ref.key}}`
  return {
    kind: 'variable_unresolved',
    message: `Unresolved variable ${labeled} on ${state.composeServiceName}.${envKey}`,
    ref: labeled,
    composeServiceName: state.composeServiceName,
    envKey,
  }
}

function secretInterpolationError(
  state: ApplyServiceState,
  envKey: string,
  raw: string
): ApplyVariablesError | null {
  for (const key of collectComposeInterpolationKeys(raw)) {
    if (!state.secretKeys.has(key)) continue
    return {
      kind: 'variable_secret_interpolation',
      message: `Secret ${key} cannot use Compose \${${key}} interpolation; use {$${key}} so it becomes a file`,
      composeServiceName: state.composeServiceName,
      envKey,
    }
  }
  return null
}

function recordSecretAssignment(
  state: ApplyServiceState,
  name: string,
  entry: DeployVariableEntry
): void {
  state.runtimeAssignments.push({
    name,
    key: entry.key,
    isSecret: true,
    value: null,
    ...(entry.source === undefined ? {} : { source: entry.source }),
  })
}

function applySecretRefValue(
  state: ApplyServiceState,
  envKey: string,
  entry: DeployVariableEntry,
  target: 'runtime' | 'build',
  runtimeEnv: Record<string, string>,
  buildArgs: Record<string, string>
): void {
  if (target === 'runtime') {
    delete runtimeEnv[envKey]
    recordSecretAssignment(state, envKey, entry)
  } else delete buildArgs[envKey]
  applySecretAssignment(
    state,
    {
      ...entry,
      forRuntime: target === 'runtime' ? true : entry.forRuntime,
      forBuild: target === 'build' ? true : entry.forBuild,
    },
    runtimeEnv,
    envKey
  )
}

function applyRefValue(
  state: ApplyServiceState,
  envKey: string,
  raw: string,
  target: 'runtime' | 'build',
  runtimeEnv: Record<string, string>,
  buildArgs: Record<string, string>
): ApplyVariablesError | null {
  const parsed = parseExactVariableRef(raw)
  if (!parsed.ok && parsed.error === 'not_a_ref') {
    return secretInterpolationError(state, envKey, raw)
  }
  if (!parsed.ok) {
    return {
      kind: 'variable_ref_invalid',
      message: parsed.message,
      composeServiceName: state.composeServiceName,
      envKey,
    }
  }

  const entry = lookupVariable(parsed.ref, state.inherited, state.scopes)
  if (!entry) return unresolvedError(state, parsed.ref, envKey)

  if (entry.isSecret) {
    applySecretRefValue(state, envKey, entry, target, runtimeEnv, buildArgs)
    return null
  }

  applyNonSecretAssignment(state, envKey, entry, target, runtimeEnv, buildArgs)
  return null
}

function scanMapForRefs(
  state: ApplyServiceState,
  values: Record<string, string>,
  target: 'runtime' | 'build',
  runtimeEnv: Record<string, string>,
  buildArgs: Record<string, string>
): ApplyVariablesError | null {
  for (const [envKey, raw] of Object.entries(values)) {
    const error = applyRefValue(state, envKey, raw, target, runtimeEnv, buildArgs)
    if (error) return error
  }
  return null
}

/**
 * A secret nothing references is attached on its own only when it is owned by a
 * binding, or — for a native app — when it was set on the app itself (its
 * service or one of its hostnames). A secret set higher up (organization,
 * workspace, project, environment, server) still needs a `{$KEY}` reference, so
 * a credential set for the whole organization never lands in an app that did
 * not ask for it; containers keep that rule for every scope.
 */
function shouldAutoAttachSecret(state: ApplyServiceState, entry: DeployVariableEntry): boolean {
  if (state.plannedKeys.has(entry.key)) return false
  if (entry.bindingId) return true
  return (
    state.nativeApp &&
    entry.forRuntime &&
    (entry.source === 'service' || entry.source === 'hosting')
  )
}

function attachUnreferencedSecret(
  state: ApplyServiceState,
  entry: DeployVariableEntry,
  runtimeEnv: Record<string, string>
): void {
  if (shouldAutoAttachSecret(state, entry)) {
    applySecretAssignment(state, entry, runtimeEnv)
    if (entry.forRuntime) recordSecretAssignment(state, entry.key, entry)
    return
  }
  if (state.nativeApp && entry.forRuntime && !state.plannedKeys.has(entry.key)) {
    state.unreferencedSecrets.push({
      key: entry.key,
      ...(entry.source === undefined ? {} : { source: entry.source }),
    })
  }
}

function autoInjectEntries(state: ApplyServiceState): void {
  const runtimeEnv = readStringEnvMap(state.service.environment)
  const buildArgs = isRecord(state.service.build) ? readStringEnvMap(state.service.build.args) : {}

  for (const entry of state.inherited.values()) {
    if (entry.isSecret) {
      attachUnreferencedSecret(state, entry, runtimeEnv)
      continue
    }
    if (entry.forRuntime) {
      applyNonSecretAssignment(state, entry.key, entry, 'runtime', runtimeEnv, buildArgs)
    }
    if (entry.forBuild) {
      applyNonSecretAssignment(state, entry.key, entry, 'build', runtimeEnv, buildArgs)
    }
  }

  writeStringEnvMap(state.service, runtimeEnv)
  writeBuildArgs(state.service, buildArgs)
}

function applyEntriesToService(state: ApplyServiceState): ApplyVariablesError | null {
  const runtimeEnv = readStringEnvMap(state.service.environment)
  const buildArgs = isRecord(state.service.build) ? readStringEnvMap(state.service.build.args) : {}

  const runtimeErr = scanMapForRefs(state, runtimeEnv, 'runtime', runtimeEnv, buildArgs)
  if (runtimeErr) return runtimeErr
  const buildErr = scanMapForRefs(state, buildArgs, 'build', runtimeEnv, buildArgs)
  if (buildErr) return buildErr

  writeStringEnvMap(state.service, runtimeEnv)
  writeBuildArgs(state.service, buildArgs)
  autoInjectEntries(state)
  return null
}

/**
 * Inject resolved variables into a merged compose document.
 *
 * Non-secrets land in a generated `.env` with `${service__KEY}` in YAML.
 * Secrets referenced with `{$…}` (or binding-owned secrets) become Compose
 * standalone `secrets:` file mounts — never environment values.
 */
export function applyVariablesToComposeDocument(
  document: ComposeDocument,
  params: {
    globalEntries: DeployVariableEntry[]
    perServiceEntries: Map<string, DeployVariableEntry[]>
    perServiceScopes?: Map<string, VariableScopeEntryMap>
    /** Compose services that are native (`serviceKind: node`) apps. */
    nativeServiceNames?: ReadonlySet<string>
    projectId?: string
    environmentId?: string
    runDir?: string
  }
): ApplyVariablesResult | ApplyVariablesError {
  const data = { ...document.data }
  const services = isRecord(data.services) ? { ...data.services } : {}
  const secretMaterial: DeployVariableMaterial[] = []
  const secretPlan: DeploySecretPlanEntry[] = []
  const envEntries: EnvFileEntry[] = []
  const runtimeAssignments = new Map<string, RuntimeEnvAssignment[]>()
  const unreferencedSecrets = new Map<string, UnreferencedSecret[]>()
  const runDir = params.runDir ?? DEFAULT_DEPLOY_RUN_DIR
  const projectId = params.projectId ?? 'preview'
  const environmentId = params.environmentId ?? 'preview'

  for (const composeServiceName of listComposeServiceNames(document)) {
    const rawService = services[composeServiceName]
    if (!isRecord(rawService)) continue

    const inherited = entriesToMap([
      ...params.globalEntries,
      ...(params.perServiceEntries.get(composeServiceName) ?? []),
    ])
    const state: ApplyServiceState = {
      service: { ...rawService },
      data,
      composeServiceName,
      inherited,
      scopes: params.perServiceScopes?.get(composeServiceName),
      secretKeys: collectSecretKeys(inherited, params.perServiceScopes?.get(composeServiceName)),
      plannedKeys: new Set(),
      secretMaterial,
      secretPlan,
      envEntries,
      runtimeAssignments: [],
      nativeApp: params.nativeServiceNames?.has(composeServiceName) ?? false,
      unreferencedSecrets: [],
      projectId,
      environmentId,
      runDir,
    }
    const error = applyEntriesToService(state)
    if (error) return error
    services[composeServiceName] = state.service
    runtimeAssignments.set(composeServiceName, state.runtimeAssignments)
    unreferencedSecrets.set(composeServiceName, state.unreferencedSecrets)
  }

  data.services = services

  return {
    document: {
      version: 1,
      data,
      presentation: document.presentation,
    },
    secretMaterial,
    secretPlan,
    envFileContent: encodeEnvFile(envEntries),
    runtimeAssignments,
    unreferencedSecrets,
  }
}

/** Masked placeholder for secret-backed values in deploy-preview YAML. */
export const DEPLOY_PREVIEW_SECRET_PLACEHOLDER = '••••••••'

/**
 * Preview YAML already uses `secrets:` file paths and `KEY_FILE`. Secret
 * values are never written into environment/build.args.
 */
export function injectSecretPlaceholdersIntoComposeDocument(
  document: ComposeDocument,
  _secretMaterial: readonly DeployVariableMaterial[],
  _placeholder: string = DEPLOY_PREVIEW_SECRET_PLACEHOLDER
): ComposeDocument {
  return document
}

export function isApplyVariablesError(
  value: ApplyVariablesResult | ApplyVariablesError
): value is ApplyVariablesError {
  return 'kind' in value
}
