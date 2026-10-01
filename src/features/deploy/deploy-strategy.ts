/**
 * Which deploy strategy a deploy would really use, and why.
 *
 * Pure: compose data and resolved options in, `{ effectiveStrategy,
 * fallbackReasons }` out. Stage 1 of the deploy-strategy work surfaces this on
 * the deploy preview; nothing acts on it yet, so a deploy still runs
 * `inplace`.
 *
 * Rules (design section 2b and 4, owner decisions 2026-10-01):
 * - `inplace` and `sequential` are always possible as requested;
 * - `bluegreen` is refused, and the deploy falls back to `sequential` with a
 *   visible reason per cause, when two generations could not safely coexist:
 *   host-published ports or host networking, an authored `container_name`, a
 *   stateful service with a writable volume, a traffic-facing service with no
 *   healthcheck, native (site/node) or cron services, host-level binds, or a
 *   migration status that is not `none` / `compatible` (unknown included).
 */

import { collectHostAccessFindings } from '../compose/host-access.ts'
import { isHostNativeServiceKind, readServiceTurbopanelExtension } from '../compose/service-kind.ts'
import {
  type DeployStrategy,
  type MigrationStatus,
  resolveDeployOptions,
} from './deploy-options.ts'

export type FallbackReasonCode =
  | 'host_published_ports'
  | 'authored_container_name'
  | 'stateful_writable_volume'
  | 'missing_healthcheck'
  | 'native_or_cron_service'
  | 'host_level_binds'
  | 'migration_unknown'
  | 'migration_breaking'
  | 'migrator_undeclared'

export type FallbackReason = {
  code: FallbackReasonCode
  /** Operator-facing sentence, finishing "Blue-green isn't possible because ...". */
  message: string
  /** Compose service names that caused it (sorted); empty for project-wide causes. */
  services: string[]
}

export type StrategyFacts = {
  hostPublishedPorts: string[]
  authoredContainerNames: string[]
  statefulWritableVolumes: string[]
  /** Traffic-facing services (hosting, ports or expose) with no healthcheck. */
  missingHealthchecks: string[]
  nativeOrCron: string[]
  hostLevelBinds: string[]
  /**
   * A migrator was detected (one-shot service or pre-deploy hook). Stage 4
   * computes this; stage 1 callers pass `false`.
   */
  migratorDetected: boolean
}

export type EffectiveStrategy = {
  requested: DeployStrategy
  effectiveStrategy: DeployStrategy
  fallbackReasons: FallbackReason[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Image repository name without registry, namespace or tag or digest. */
function imageBaseName(image: unknown): string {
  if (typeof image !== 'string') return ''
  const noDigest = image.split('@')[0]
  const lastSegment = noDigest.split('/').at(-1) ?? ''
  return lastSegment.split(':')[0].toLowerCase()
}

/**
 * Images that own durable state. A heuristic, used only to *raise* caution:
 * a hit refuses blue-green, a miss never clears anything else.
 */
const STATEFUL_IMAGES = new Set([
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'mongo',
  'mongodb',
  'redis',
  'valkey',
  'rabbitmq',
  'elasticsearch',
  'opensearch',
  'cassandra',
  'couchdb',
  'influxdb',
  'kafka',
  'minio',
])

/** Short-syntax mount: `src:dst[:opts]`; read-only when `ro` is in opts. */
function isWritableShortMount(entry: string): boolean {
  const parts = entry.split(':')
  if (parts.length < 2) return true
  const options = parts.slice(2).join(',').split(',')
  return !options.includes('ro')
}

function isWritableLongMount(entry: Record<string, unknown>): boolean {
  if (entry.type === 'tmpfs') return false
  return entry.read_only !== true
}

function hasWritableVolume(service: Record<string, unknown>): boolean {
  if (!Array.isArray(service.volumes)) return false
  return service.volumes.some((entry) => {
    if (typeof entry === 'string') return isWritableShortMount(entry)
    return isRecord(entry) && isWritableLongMount(entry)
  })
}

/** Short `HOST:CONTAINER` / `IP:HOST:CONTAINER` publishes a host port; `CONTAINER` alone does not. */
function shortPortPublishes(entry: string): boolean {
  return entry.split('/')[0].split(':').length > 1
}

function longPortPublishes(entry: Record<string, unknown>): boolean {
  return entry.published !== undefined && entry.published !== null && entry.published !== ''
}

function publishesHostPort(service: Record<string, unknown>): boolean {
  if (service.network_mode === 'host') return true
  if (!Array.isArray(service.ports)) return false
  return service.ports.some((entry) => {
    if (typeof entry === 'string') return shortPortPublishes(entry)
    if (typeof entry === 'number') return false
    return isRecord(entry) && longPortPublishes(entry)
  })
}

function hasHostings(service: Record<string, unknown>): boolean {
  const extension = service['x-turbopanel']
  return isRecord(extension) && Array.isArray(extension.hosting) && extension.hosting.length > 0
}

function isTrafficFacing(service: Record<string, unknown>): boolean {
  if (hasHostings(service)) return true
  const ports = Array.isArray(service.ports) && service.ports.length > 0
  const expose = Array.isArray(service.expose) && service.expose.length > 0
  return ports || expose
}

function hasHealthcheck(service: Record<string, unknown>): boolean {
  const check = service.healthcheck
  if (!isRecord(check)) return false
  return check.disable !== true
}

/** Raw read on purpose: a malformed job the parser would drop still means "has cron". */
function hasCronJobs(service: Record<string, unknown>): boolean {
  const extension = service['x-turbopanel']
  return isRecord(extension) && Array.isArray(extension.cron) && extension.cron.length > 0
}

function isNativeOrCron(service: Record<string, unknown>): boolean {
  const extension = readServiceTurbopanelExtension(service)
  if (extension !== null && isHostNativeServiceKind(extension.serviceKind)) return true
  return hasCronJobs(service)
}

type ServiceTest = (service: Record<string, unknown>) => boolean

const SERVICE_TESTS: Record<
  Exclude<keyof StrategyFacts, 'migratorDetected' | 'hostLevelBinds'>,
  ServiceTest
> = {
  hostPublishedPorts: publishesHostPort,
  authoredContainerNames: (service) => typeof service.container_name === 'string',
  statefulWritableVolumes: (service) =>
    STATEFUL_IMAGES.has(imageBaseName(service.image)) && hasWritableVolume(service),
  missingHealthchecks: (service) => isTrafficFacing(service) && !hasHealthcheck(service),
  nativeOrCron: isNativeOrCron,
}

/** Service names whose body passes `test`, sorted. */
function namesWhere(services: Record<string, unknown>, test: ServiceTest): string[] {
  const names: string[] = []
  for (const [name, body] of Object.entries(services)) {
    if (isRecord(body) && test(body)) names.push(name)
  }
  return names.toSorted((a, b) => a.localeCompare(b))
}

/** Host-level binds name a path, not a service; report the service when the path is `services.<name>...`. */
function hostLevelBindServices(data: Record<string, unknown>): string[] {
  const names = new Set<string>()
  for (const finding of collectHostAccessFindings(data)) {
    const segments = finding.segments
    if (segments[0] === 'services' && typeof segments[1] === 'string') names.add(segments[1])
  }
  return [...names].toSorted((a, b) => a.localeCompare(b))
}

/** Facts about the merged compose document that decide blue-green eligibility. */
export function collectStrategyFacts(
  composeData: Record<string, unknown> | null | undefined,
  options: { migratorDetected?: boolean } = {}
): StrategyFacts {
  const data = composeData ?? {}
  const services = isRecord(data.services) ? data.services : {}
  return {
    hostPublishedPorts: namesWhere(services, SERVICE_TESTS.hostPublishedPorts),
    authoredContainerNames: namesWhere(services, SERVICE_TESTS.authoredContainerNames),
    statefulWritableVolumes: namesWhere(services, SERVICE_TESTS.statefulWritableVolumes),
    missingHealthchecks: namesWhere(services, SERVICE_TESTS.missingHealthchecks),
    nativeOrCron: namesWhere(services, SERVICE_TESTS.nativeOrCron),
    hostLevelBinds: hostLevelBindServices(data),
    migratorDetected: options.migratorDetected === true,
  }
}

type ServiceRule = {
  code: FallbackReasonCode
  facts: keyof Pick<
    StrategyFacts,
    | 'hostPublishedPorts'
    | 'authoredContainerNames'
    | 'statefulWritableVolumes'
    | 'missingHealthchecks'
    | 'nativeOrCron'
    | 'hostLevelBinds'
  >
  message: string
}

const SERVICE_RULES: readonly ServiceRule[] = [
  {
    code: 'host_published_ports',
    facts: 'hostPublishedPorts',
    message: 'two generations cannot both bind a published host port or share the host network',
  },
  {
    code: 'authored_container_name',
    facts: 'authoredContainerNames',
    message: 'a container_name written in the compose file would collide between generations',
  },
  {
    code: 'stateful_writable_volume',
    facts: 'statefulWritableVolumes',
    message: 'a stateful service has a writable volume that two generations would share',
  },
  {
    code: 'missing_healthcheck',
    facts: 'missingHealthchecks',
    message: 'a service that receives traffic has no healthcheck to gate the cutover on',
  },
  {
    code: 'native_or_cron_service',
    facts: 'nativeOrCron',
    message: 'site, node and scheduled-job services run once per host and would double-run',
  },
  {
    code: 'host_level_binds',
    facts: 'hostLevelBinds',
    message: 'host-level binds would be shared between generations',
  },
]

function serviceReasons(facts: StrategyFacts): FallbackReason[] {
  const reasons: FallbackReason[] = []
  for (const rule of SERVICE_RULES) {
    const services = facts[rule.facts]
    if (services.length === 0) continue
    reasons.push({ code: rule.code, message: rule.message, services: [...services] })
  }
  return reasons
}

function migrationReasons(migrations: MigrationStatus, facts: StrategyFacts): FallbackReason[] {
  if (migrations === 'unknown') {
    return [
      {
        code: 'migration_unknown',
        message:
          'migrations are not declared for this environment, so old code could run against a changed schema',
        services: [],
      },
    ]
  }
  if (migrations === 'breaking') {
    return [
      {
        code: 'migration_breaking',
        message:
          'this deploy has a breaking migration, which must run with the old version stopped',
        services: [],
      },
    ]
  }
  if (migrations === 'none' && facts.migratorDetected) {
    return [
      {
        code: 'migrator_undeclared',
        message: 'a migration step was detected but migrations are declared as none',
        services: [],
      },
    ]
  }
  return []
}

/**
 * The strategy a deploy would use. Only `bluegreen` can fall back, and only to
 * `sequential`; the reasons are every refusal that applies, not just the first.
 */
export function computeEffectiveStrategy(input: {
  requested: DeployStrategy
  migrations: MigrationStatus
  facts: StrategyFacts
}): EffectiveStrategy {
  const { requested, migrations, facts } = input
  if (requested !== 'bluegreen') {
    return { requested, effectiveStrategy: requested, fallbackReasons: [] }
  }
  const fallbackReasons = [...serviceReasons(facts), ...migrationReasons(migrations, facts)]
  return {
    requested,
    effectiveStrategy: fallbackReasons.length === 0 ? 'bluegreen' : 'sequential',
    fallbackReasons,
  }
}

export type DeployStrategyPreview = EffectiveStrategy & {
  /** The migration status the decision used (override, else environment, else `unknown`). */
  migrations: MigrationStatus
}

/**
 * The deploy-preview answer: stored settings (environment over project over
 * defaults), an optional per-request what-if override, and the merged compose.
 */
export function previewDeployStrategy(input: {
  environmentOptions: unknown
  projectOptions: unknown
  composeData: Record<string, unknown> | null | undefined
  override?: { strategy?: DeployStrategy | null; migration?: MigrationStatus | null }
}): DeployStrategyPreview {
  const resolved = resolveDeployOptions(input.environmentOptions, input.projectOptions)
  const requested = input.override?.strategy ?? resolved.deployStrategy
  const migrations = input.override?.migration ?? resolved.migrations
  const facts = collectStrategyFacts(input.composeData)
  return { ...computeEffectiveStrategy({ requested, migrations, facts }), migrations }
}
