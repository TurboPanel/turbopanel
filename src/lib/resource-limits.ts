/** Organization and server resource limit models. */

export type ResourceLimits = {
  maxCpus?: number
  maxMemoryBytes?: number
  maxServicesPerEnvironment?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOptionalPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value > 0 ? value : undefined
}

export function parseResourceLimits(value: unknown): ResourceLimits | null {
  if (value === null || value === undefined) return {}
  if (!isRecord(value)) return null

  const limits: ResourceLimits = {}
  const maxCpus = readOptionalPositiveNumber(value.maxCpus)
  if (maxCpus !== undefined) limits.maxCpus = maxCpus
  const maxMemoryBytes = readOptionalPositiveNumber(value.maxMemoryBytes)
  if (maxMemoryBytes !== undefined) limits.maxMemoryBytes = maxMemoryBytes
  const maxServices = readOptionalPositiveNumber(value.maxServicesPerEnvironment)
  if (maxServices !== undefined) limits.maxServicesPerEnvironment = maxServices
  return limits
}

export type ResourceUsage = {
  cpus: number
  memoryBytes: number
  serviceCount: number
}

export type ResourceLimitViolation = {
  scope: 'organization' | 'server'
  field: keyof ResourceLimits
  limit: number
  requested: number
}

export function checkResourceLimits(
  usage: ResourceUsage,
  orgLimits: ResourceLimits,
  serverLimits: ResourceLimits,
): ResourceLimitViolation[] {
  const violations: ResourceLimitViolation[] = []

  const checks: Array<{
    scope: 'organization' | 'server'
    limits: ResourceLimits
  }> = [
    { scope: 'organization', limits: orgLimits },
    { scope: 'server', limits: serverLimits },
  ]

  for (const { scope, limits } of checks) {
    if (limits.maxCpus !== undefined && usage.cpus > limits.maxCpus) {
      violations.push({
        scope,
        field: 'maxCpus',
        limit: limits.maxCpus,
        requested: usage.cpus,
      })
    }
    if (limits.maxMemoryBytes !== undefined && usage.memoryBytes > limits.maxMemoryBytes) {
      violations.push({
        scope,
        field: 'maxMemoryBytes',
        limit: limits.maxMemoryBytes,
        requested: usage.memoryBytes,
      })
    }
    if (
      limits.maxServicesPerEnvironment !== undefined &&
      usage.serviceCount > limits.maxServicesPerEnvironment
    ) {
      violations.push({
        scope,
        field: 'maxServicesPerEnvironment',
        limit: limits.maxServicesPerEnvironment,
        requested: usage.serviceCount,
      })
    }
  }

  return violations
}

export function sumServiceResourceUsage(
  optionsByComposeName: Map<string, { resources?: { cpus?: number; memoryBytes?: number } }>,
  composeServiceCount?: number,
): ResourceUsage {
  let cpus = 0
  let memoryBytes = 0
  for (const options of optionsByComposeName.values()) {
    if (options.resources?.cpus !== undefined) cpus += options.resources.cpus
    if (options.resources?.memoryBytes !== undefined) {
      memoryBytes += options.resources.memoryBytes
    }
  }
  return {
    cpus,
    memoryBytes,
    serviceCount: composeServiceCount ?? optionsByComposeName.size,
  }
}

export function clampServiceResources(
  options: { resources?: { cpus?: number; memoryBytes?: number } },
  orgLimits: ResourceLimits,
  serverLimits: ResourceLimits,
): { resources?: { cpus?: number; memoryBytes?: number } } {
  const resources = { ...options.resources }
  const maxCpus = Math.min(
    orgLimits.maxCpus ?? Number.POSITIVE_INFINITY,
    serverLimits.maxCpus ?? Number.POSITIVE_INFINITY,
  )
  const maxMemory = Math.min(
    orgLimits.maxMemoryBytes ?? Number.POSITIVE_INFINITY,
    serverLimits.maxMemoryBytes ?? Number.POSITIVE_INFINITY,
  )

  if (resources.cpus !== undefined && Number.isFinite(maxCpus)) {
    resources.cpus = Math.min(resources.cpus, maxCpus)
  }
  if (resources.memoryBytes !== undefined && Number.isFinite(maxMemory)) {
    resources.memoryBytes = Math.min(resources.memoryBytes, maxMemory)
  }

  return { resources }
}
