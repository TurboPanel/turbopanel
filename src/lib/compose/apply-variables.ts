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

function readStringEnvMap(value: unknown): Record<string, string> {
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
