import type { ComposeDocument } from './types.ts'

export type DeployVariableEntry = {
  key: string
  value: string
  isSecret: boolean
  isLiteral: boolean
  forBuild: boolean
  forRuntime: boolean
}

export type DeployVariableMaterial = {
  key: string
  composeServiceName: string | null
  forBuild: boolean
  forRuntime: boolean
  isLiteral: boolean
  valueEnvelope: string
}

export type ApplyVariablesResult = {
  document: ComposeDocument
  /** Secret values sealed for daemon delivery — never embed in compose YAML. */
  secretMaterial: DeployVariableMaterial[]
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

function formatEnvValue(entry: DeployVariableEntry): string {
  const trimmed = trimVariableValue(entry.value)
  return entry.isLiteral ? escapeLiteralComposeValue(trimmed) : trimmed
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

function mergeBuildArgs(
  service: Record<string, unknown>,
  args: Record<string, string>,
): void {
  if (Object.keys(args).length === 0) return
  const build = isRecord(service.build) ? { ...service.build } : {}
  const existing = readStringEnvMap(build.args)
  build.args = { ...existing, ...args }
  service.build = build
}

function listComposeServiceNames(document: ComposeDocument): string[] {
  const services = document.data.services
  if (!isRecord(services)) return []
  return Object.keys(services).sort((a, b) => a.localeCompare(b))
}

function applyEntriesToService(
  service: Record<string, unknown>,
  entries: DeployVariableEntry[],
  secretMaterial: DeployVariableMaterial[],
  composeServiceName: string,
): void {
  const runtimeEnv = readStringEnvMap(service.environment)
  const buildArgs: Record<string, string> = {}

  for (const entry of entries) {
    if (entry.isSecret) {
      secretMaterial.push({
        key: entry.key,
        composeServiceName,
        forBuild: entry.forBuild,
        forRuntime: entry.forRuntime,
        isLiteral: entry.isLiteral,
        valueEnvelope: entry.value,
      })
      continue
    }

    const formatted = formatEnvValue(entry)
    if (entry.forRuntime) runtimeEnv[entry.key] = formatted
    if (entry.forBuild) buildArgs[entry.key] = formatted
  }

  writeStringEnvMap(service, runtimeEnv)
  mergeBuildArgs(service, buildArgs)
}

/**
 * Inject resolved variables into a merged compose document.
 * Plaintext values land in compose; secrets are returned for daemon-side injection.
 */
export function applyVariablesToComposeDocument(
  document: ComposeDocument,
  params: {
    globalEntries: DeployVariableEntry[]
    perServiceEntries: Map<string, DeployVariableEntry[]>
  },
): ApplyVariablesResult {
  const data = { ...document.data }
  const services = isRecord(data.services) ? { ...data.services } : {}
  const secretMaterial: DeployVariableMaterial[] = []

  for (const composeServiceName of listComposeServiceNames(document)) {
    const rawService = services[composeServiceName]
    if (!isRecord(rawService)) continue

    const service = { ...rawService }
    const serviceEntries = params.perServiceEntries.get(composeServiceName) ?? []
    const mergedEntries = [...params.globalEntries, ...serviceEntries]
    applyEntriesToService(service, mergedEntries, secretMaterial, composeServiceName)
    services[composeServiceName] = service
  }

  data.services = services

  return {
    document: {
      version: 1,
      data,
      presentation: document.presentation,
    },
    secretMaterial,
  }
}

/** Masked placeholder for secret-backed values in deploy-preview YAML. */
export const DEPLOY_PREVIEW_SECRET_PLACEHOLDER = '••••••••'

/**
 * Inject masked placeholders for secret material keys into compose YAML so a
 * deploy preview can show which secret env/build keys exist without revealing
 * values (write-only secret rule).
 */
export function injectSecretPlaceholdersIntoComposeDocument(
  document: ComposeDocument,
  secretMaterial: readonly DeployVariableMaterial[],
  placeholder: string = DEPLOY_PREVIEW_SECRET_PLACEHOLDER,
): ComposeDocument {
  if (secretMaterial.length === 0) return document

  const data = { ...document.data }
  const services = isRecord(data.services) ? { ...data.services } : {}

  for (const entry of secretMaterial) {
    if (!entry.composeServiceName) continue
    const rawService = services[entry.composeServiceName]
    if (!isRecord(rawService)) continue

    const service = { ...rawService }
    if (entry.forRuntime) {
      const runtimeEnv = readStringEnvMap(service.environment)
      runtimeEnv[entry.key] = placeholder
      writeStringEnvMap(service, runtimeEnv)
    }
    if (entry.forBuild) {
      mergeBuildArgs(service, { [entry.key]: placeholder })
    }
    services[entry.composeServiceName] = service
  }

  data.services = services
  return {
    version: 1,
    data,
    presentation: document.presentation,
  }
}
