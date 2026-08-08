import type { ComposeDocument } from './types.ts'
import {
  formatStopGracePeriod,
  parseServiceOptions,
  resolveHealthCheckPolicy,
  resolveMaxRestartAttempts,
  resolveStopGracePeriodSeconds,
  type ServiceOptions,
} from '../service-options.ts'
import { isTraditionalWebComposeService } from './service-kind.ts'

export type ServiceOptionsByComposeName = Map<string, ServiceOptions>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listComposeServiceNames(document: ComposeDocument): string[] {
  const services = document.data.services
  if (!isRecord(services)) return []
  return Object.keys(services).sort((a, b) => a.localeCompare(b))
}

function hasHealthCheck(service: Record<string, unknown>): boolean {
  return isRecord(service.healthcheck)
}

export function serviceHasComposeHealthCheck(
  document: ComposeDocument,
  composeServiceName: string,
): boolean {
  const services = document.data.services
  if (!isRecord(services)) return false
  const service = services[composeServiceName]
  return isRecord(service) && hasHealthCheck(service)
}

export type HealthCheckWarning = {
  composeServiceName: string
  policy: 'warn' | 'required'
}

export function collectHealthCheckWarnings(
  document: ComposeDocument,
  optionsByComposeName: ServiceOptionsByComposeName,
): HealthCheckWarning[] {
  const warnings: HealthCheckWarning[] = []
  for (const composeServiceName of listComposeServiceNames(document)) {
    const options = optionsByComposeName.get(composeServiceName) ?? {}
    const parsed = parseServiceOptions(options) ?? {}
    const policy = resolveHealthCheckPolicy(parsed)
    if (policy === 'disabled') continue
    const services = document.data.services
    const rawService = isRecord(services) ? services[composeServiceName] : undefined
    // Traditional-web sites are host nginx/apache — not Docker healthchecks.
    if (isRecord(rawService) && isTraditionalWebComposeService(rawService)) {
      continue
    }
    // Compose `healthcheck:` (or an image HEALTHCHECK once Docker reports it)
    // is enough — we only gate when the operator opted into warn/required and
    // the compose service has no healthcheck block.
    if (isRecord(rawService) && hasHealthCheck(rawService)) {
      continue
    }
    if (policy === 'warn' || policy === 'required') {
      warnings.push({ composeServiceName, policy })
    }
  }
  return warnings
}

/**
 * Map Coolify-style resource limits onto a Compose service fragment.
 * Shared by tenant deploy and managed-engine runtime specs so `cpus` /
 * `mem_limit` / `mem_reservation` / `deploy.resources.limits` never drift.
 */
export function applyResourcesToComposeService(
  service: Record<string, unknown>,
  resources: NonNullable<ServiceOptions['resources']>,
): void {
  if (resources.cpus !== undefined) {
    service.cpus = resources.cpus
  }
  if (resources.memoryBytes !== undefined) {
    service.mem_limit = resources.memoryBytes
  }
  if (resources.memoryReservationBytes !== undefined) {
    service.mem_reservation = resources.memoryReservationBytes
  }

  const deploy = isRecord(service.deploy) ? { ...service.deploy } : {}
  const deployResources = isRecord(deploy.resources) ? { ...deploy.resources } : {}
  const limits = isRecord(deployResources.limits) ? { ...deployResources.limits } : {}

  if (resources.cpus !== undefined) {
    limits.cpus = String(resources.cpus)
  }
  if (resources.memoryBytes !== undefined) {
    limits.memory = `${resources.memoryBytes}`
  }

  if (Object.keys(limits).length > 0) {
    deployResources.limits = limits
    deploy.resources = deployResources
    service.deploy = deploy
  }
}

function applyRestartPolicy(
  service: Record<string, unknown>,
  maxAttempts: number,
): void {
  const deploy = isRecord(service.deploy) ? { ...service.deploy } : {}
  const restartPolicy: Record<string, unknown> = isRecord(deploy.restart_policy)
    ? { ...deploy.restart_policy }
    : { condition: 'on-failure' }
  restartPolicy.max_attempts = maxAttempts
  deploy.restart_policy = restartPolicy
  service.deploy = deploy
}

export type ServiceDeployHook = {
  composeServiceName: string
  preDeployCommand?: string
  postDeployCommand?: string
  buildDisableCache?: boolean
}

export type ApplyServiceOptionsResult = {
  document: ComposeDocument
  hooks: ServiceDeployHook[]
}

function applyParsedOptionsToService(
  service: Record<string, unknown>,
  parsed: ServiceOptions,
  containerName: string | undefined,
): void {
  if (containerName !== undefined && containerName.length > 0) {
    service.container_name = containerName
  }

  if (service.stop_grace_period === undefined) {
    service.stop_grace_period = formatStopGracePeriod(
      resolveStopGracePeriodSeconds(parsed),
    )
  }

  if (parsed.resources) {
    applyResourcesToComposeService(service, parsed.resources)
  }

  applyRestartPolicy(service, resolveMaxRestartAttempts(parsed))
}

function buildServiceDeployHook(
  composeServiceName: string,
  parsed: ServiceOptions,
): ServiceDeployHook | undefined {
  const hook: ServiceDeployHook = { composeServiceName }
  if (parsed.preDeployCommand) hook.preDeployCommand = parsed.preDeployCommand
  if (parsed.postDeployCommand) hook.postDeployCommand = parsed.postDeployCommand
  if (parsed.build?.disableCache) hook.buildDisableCache = true
  if (hook.preDeployCommand || hook.postDeployCommand || hook.buildDisableCache) {
    return hook
  }
  return undefined
}

export function applyServiceOptionsToComposeDocument(
  document: ComposeDocument,
  optionsByComposeName: ServiceOptionsByComposeName,
  /**
   * Allocation is the sole writer of compose `container_name`. Keys are
   * (possibly clone) compose service names → allocated container_name values.
   * Overwrites any operator-typed value on the document.
   */
  containerNameByComposeName?: ReadonlyMap<string, string>,
): ApplyServiceOptionsResult {
  const data = { ...document.data }
  const services = isRecord(data.services) ? { ...data.services } : {}
  const hooks: ServiceDeployHook[] = []

  for (const composeServiceName of listComposeServiceNames(document)) {
    const rawService = services[composeServiceName]
    if (!isRecord(rawService)) continue

    const service = { ...rawService }
    const parsed = parseServiceOptions(optionsByComposeName.get(composeServiceName)) ?? {}
    applyParsedOptionsToService(
      service,
      parsed,
      containerNameByComposeName?.get(composeServiceName),
    )

    const hook = buildServiceDeployHook(composeServiceName, parsed)
    if (hook) hooks.push(hook)

    services[composeServiceName] = service
  }

  data.services = services

  return {
    document: {
      version: 1,
      data,
      presentation: document.presentation,
    },
    hooks,
  }
}

export function buildServiceOptionsMap(
  rows: Array<{ composeServiceName: string; options: unknown }>,
): ServiceOptionsByComposeName {
  const map: ServiceOptionsByComposeName = new Map()
  for (const row of rows) {
    const parsed = parseServiceOptions(row.options)
    if (parsed) map.set(row.composeServiceName, parsed)
  }
  return map
}
