/** Validated `service.options` shape for Coolify-style per-service settings. */

export type HealthCheckPolicy = 'disabled' | 'warn' | 'required'

export type ServiceOptions = {
  preDeployCommand?: string
  postDeployCommand?: string
  /** Desired instance count for this service (1 = single container). */
  instances?: number
  build?: {
    disableCache?: boolean
  }
  container?: {
    name?: string
  }
  operations?: {
    stopGracePeriodSeconds?: number
    maxRestartAttempts?: number
  }
  healthCheck?: {
    policy?: HealthCheckPolicy
  }
  resources?: {
    cpus?: number
    memoryBytes?: number
    memoryReservationBytes?: number
  }
}

const DEFAULT_STOP_GRACE_SECONDS = 30
const DEFAULT_MAX_RESTART_ATTEMPTS = 10
const DEFAULT_HEALTH_POLICY: HealthCheckPolicy = 'warn'
const DEFAULT_SERVICE_INSTANCES = 1
/** Drop-invalid ceiling for `service.options.instances`. */
export const MAX_SERVICE_INSTANCES = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHealthCheckPolicy(value: unknown): value is HealthCheckPolicy {
  return value === 'disabled' || value === 'warn' || value === 'required'
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.floor(value)
  return rounded > 0 ? rounded : undefined
}

function readOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value >= 0 ? value : undefined
}

function parseBuild(value: Record<string, unknown>): ServiceOptions['build'] | undefined {
  if (!isRecord(value.build)) return undefined
  if (value.build.disableCache !== true) return undefined
  return { disableCache: true }
}

function parseContainer(value: Record<string, unknown>): ServiceOptions['container'] | undefined {
  if (!isRecord(value.container)) return undefined
  const name = readOptionalString(value.container.name)
  return name ? { name } : undefined
}

function parseOperations(value: Record<string, unknown>): ServiceOptions['operations'] | undefined {
  if (!isRecord(value.operations)) return undefined
  const operations: NonNullable<ServiceOptions['operations']> = {}
  const stopGrace = readOptionalPositiveInt(value.operations.stopGracePeriodSeconds)
  if (stopGrace !== undefined) operations.stopGracePeriodSeconds = stopGrace
  const maxRestart = readOptionalPositiveInt(value.operations.maxRestartAttempts)
  if (maxRestart !== undefined) operations.maxRestartAttempts = maxRestart
  return Object.keys(operations).length > 0 ? operations : undefined
}

function parseResources(value: Record<string, unknown>): ServiceOptions['resources'] | undefined {
  if (!isRecord(value.resources)) return undefined
  const resources: NonNullable<ServiceOptions['resources']> = {}
  const cpus = readOptionalNonNegativeNumber(value.resources.cpus)
  if (cpus !== undefined) resources.cpus = cpus
  const memoryBytes = readOptionalPositiveInt(value.resources.memoryBytes)
  if (memoryBytes !== undefined) resources.memoryBytes = memoryBytes
  const memoryReservationBytes = readOptionalPositiveInt(value.resources.memoryReservationBytes)
  if (memoryReservationBytes !== undefined) {
    resources.memoryReservationBytes = memoryReservationBytes
  }
  return Object.keys(resources).length > 0 ? resources : undefined
}

/** `undefined` = absent, `null` = present but invalid (rejects the whole document). */
function parseHealthCheck(
  value: Record<string, unknown>,
): ServiceOptions['healthCheck'] | null | undefined {
  if (!isRecord(value.healthCheck)) return undefined
  const policy = value.healthCheck.policy
  if (policy === undefined) return undefined
  if (!isHealthCheckPolicy(policy)) return null
  return { policy }
}

export function parseServiceOptions(value: unknown): ServiceOptions | null {
  if (value === null || value === undefined) return {}
  if (!isRecord(value)) return null

  const healthCheck = parseHealthCheck(value)
  if (healthCheck === null) return null

  const options: ServiceOptions = {}

  const preDeployCommand = readOptionalString(value.preDeployCommand)
  if (preDeployCommand) options.preDeployCommand = preDeployCommand

  const postDeployCommand = readOptionalString(value.postDeployCommand)
  if (postDeployCommand) options.postDeployCommand = postDeployCommand

  const instances = readOptionalPositiveInt(value.instances)
  if (instances !== undefined && instances <= MAX_SERVICE_INSTANCES) {
    options.instances = instances
  }

  const build = parseBuild(value)
  if (build) options.build = build

  const container = parseContainer(value)
  if (container) options.container = container

  const operations = parseOperations(value)
  if (operations) options.operations = operations

  if (healthCheck) options.healthCheck = healthCheck

  const resources = parseResources(value)
  if (resources) options.resources = resources

  return options
}

/** Default instance count when unset. */
export function resolveServiceInstances(
  options: ServiceOptions | null | undefined,
): number {
  return options?.instances ?? DEFAULT_SERVICE_INSTANCES
}

export function resolveStopGracePeriodSeconds(options: ServiceOptions | null | undefined): number {
  return options?.operations?.stopGracePeriodSeconds ?? DEFAULT_STOP_GRACE_SECONDS
}

export function resolveMaxRestartAttempts(options: ServiceOptions | null | undefined): number {
  return options?.operations?.maxRestartAttempts ?? DEFAULT_MAX_RESTART_ATTEMPTS
}

export function resolveHealthCheckPolicy(
  options: ServiceOptions | null | undefined,
): HealthCheckPolicy {
  return options?.healthCheck?.policy ?? DEFAULT_HEALTH_POLICY
}

export function formatStopGracePeriod(seconds: number): string {
  return `${seconds}s`
}
