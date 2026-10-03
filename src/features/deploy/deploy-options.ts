/**
 * Deploy-strategy settings kept in `environment.options` (and, for the tuning
 * knobs only, `project.options`), beside the `compose` overlay.
 *
 * This module *describes and validates* the settings; `deploy-engine.ts` reads
 * them to decide what the daemon runs. An environment with no strategy still
 * behaves as `inplace`.
 *
 * Defaults, by owner decision (2026-10-01):
 * - an environment with no `deployStrategy` is an existing one and stays
 *   `inplace`; a **new** environment is stamped `sequential` at create time
 *   ({@link stampNewEnvironmentDeployOptions});
 * - an unknown migration status is treated as unknown (never `none`), which
 *   later stages resolve to `sequential`;
 * - the old blue-green generation is shut down as soon as cutover is
 *   confirmed, so `rollbackWindowMinutes` defaults to `0`.
 */

export const DEPLOY_STRATEGIES = ['inplace', 'sequential', 'bluegreen'] as const
export type DeployStrategy = (typeof DEPLOY_STRATEGIES)[number]

export const MIGRATION_STATUSES = ['none', 'compatible', 'breaking', 'unknown'] as const
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number]

export type DeployOptions = {
  deployStrategy?: DeployStrategy
  migrations?: MigrationStatus
  /** Seconds the old generation gets to finish in-flight work before it is stopped. */
  drainSeconds?: number
  /** Seconds the health gate waits for every service to be healthy. */
  healthTimeoutSeconds?: number
  /**
   * Minutes the previous blue-green generation is kept (stopped, not removed)
   * after cutover is confirmed. `0` shuts it down immediately.
   */
  rollbackWindowMinutes?: number
}

export type ResolvedDeployOptions = Required<DeployOptions>

type IntegerLimit = { min: number; max: number; default: number }

export const DEPLOY_INTEGER_LIMITS = {
  drainSeconds: { min: 0, max: 3600, default: 30 },
  healthTimeoutSeconds: { min: 10, max: 3600, default: 120 },
  rollbackWindowMinutes: { min: 0, max: 1440, default: 0 },
} as const satisfies Record<string, IntegerLimit>

type IntegerKey = keyof typeof DEPLOY_INTEGER_LIMITS

/** Defaults applied when neither the environment nor the project says otherwise. */
export const DEFAULT_DEPLOY_STRATEGY: DeployStrategy = 'inplace'
export const DEFAULT_MIGRATION_STATUS: MigrationStatus = 'unknown'
/** What a freshly created environment is stamped with. */
export const NEW_ENVIRONMENT_DEPLOY_STRATEGY: DeployStrategy = 'sequential'

const INTEGER_KEYS = Object.keys(DEPLOY_INTEGER_LIMITS) as IntegerKey[]

/** Every key this module owns on an environment's `options`. */
export const ENVIRONMENT_DEPLOY_OPTION_KEYS: readonly string[] = [
  'deployStrategy',
  'migrations',
  ...INTEGER_KEYS,
]

/** Tuning knobs only: strategy and migration status are per-environment facts. */
export const PROJECT_DEPLOY_OPTION_KEYS: readonly string[] = INTEGER_KEYS

export type DeployOptionsScope = 'environment' | 'project'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDeployStrategy(value: unknown): value is DeployStrategy {
  return typeof value === 'string' && (DEPLOY_STRATEGIES as readonly string[]).includes(value)
}

export function isMigrationStatus(value: unknown): value is MigrationStatus {
  return typeof value === 'string' && (MIGRATION_STATUSES as readonly string[]).includes(value)
}

function isIntegerInRange(value: unknown, limit: IntegerLimit): value is number {
  return Number.isInteger(value) && (value as number) >= limit.min && (value as number) <= limit.max
}

/** Parse one strategy value (options key or per-deploy override). */
export function parseDeployStrategyInput(
  value: unknown
): { ok: true; value: DeployStrategy } | { ok: false } {
  return isDeployStrategy(value) ? { ok: true, value } : { ok: false }
}

/** Parse one migration-status value (options key or per-deploy override). */
export function parseMigrationStatusInput(
  value: unknown
): { ok: true; value: MigrationStatus } | { ok: false } {
  return isMigrationStatus(value) ? { ok: true, value } : { ok: false }
}

function readIntegerKey(
  key: IntegerKey,
  value: unknown
): { ok: true; value: number } | { ok: false; reason: string } {
  const limit = DEPLOY_INTEGER_LIMITS[key]
  if (isIntegerInRange(value, limit)) return { ok: true, value }
  return { ok: false, reason: `${key} must be an integer from ${limit.min} to ${limit.max}` }
}

/** Reason for a key that fails validation, or `null` when it is valid. */
function deployKeyReason(key: string, value: unknown): string | null {
  if (key === 'deployStrategy') {
    return isDeployStrategy(value)
      ? null
      : `deployStrategy must be one of ${DEPLOY_STRATEGIES.join(', ')}`
  }
  if (key === 'migrations') {
    return isMigrationStatus(value)
      ? null
      : `migrations must be one of ${MIGRATION_STATUSES.join(', ')}`
  }
  const parsed = readIntegerKey(key as IntegerKey, value)
  return parsed.ok ? null : parsed.reason
}

/**
 * Write-boundary validator. `null` is a valid value (it means "clear", applied
 * by {@link settleDeployOptions}); any other invalid value is refused (a
 * setting silently dropped on save would be a deploy that does not do what the
 * form said).
 *
 * A key that does not belong to `scope` is refused too, so a project cannot
 * carry a `deployStrategy` that nothing would ever read.
 */
export function validateDeployOptions(
  options: Record<string, unknown>,
  scope: DeployOptionsScope
): { ok: true } | { ok: false; reason: string } {
  const allowed =
    scope === 'environment' ? ENVIRONMENT_DEPLOY_OPTION_KEYS : PROJECT_DEPLOY_OPTION_KEYS
  for (const key of ENVIRONMENT_DEPLOY_OPTION_KEYS) {
    if (!(key in options)) continue
    if (!allowed.includes(key)) {
      return { ok: false, reason: `${key} can only be set on an environment` }
    }
    if (options[key] === null) continue
    const reason = deployKeyReason(key, options[key])
    if (reason !== null) return { ok: false, reason }
  }
  return { ok: true }
}

/**
 * The deploy keys to persist for a write that replaces `options` wholesale
 * (the PATCH and create bodies carry the whole object, and the compose editor
 * knows nothing of these keys): a key the body omits keeps its stored value, a
 * `null` clears it, anything else replaces it. Returns a new object.
 */
export function settleDeployOptions(
  existing: unknown,
  incoming: Record<string, unknown>,
  scope: DeployOptionsScope
): Record<string, unknown> {
  const keys = scope === 'environment' ? ENVIRONMENT_DEPLOY_OPTION_KEYS : PROJECT_DEPLOY_OPTION_KEYS
  const stored = isRecord(existing) ? existing : {}
  const settled: Record<string, unknown> = { ...incoming }
  for (const key of keys) {
    if (settled[key] === null) delete settled[key]
    else if (!(key in settled) && key in stored) settled[key] = stored[key]
  }
  return settled
}

/** Defensive reader: missing or invalid keys are omitted, never thrown on. */
export function parseDeployOptions(value: unknown): DeployOptions {
  if (!isRecord(value)) return {}
  const parsed: DeployOptions = {}
  if (isDeployStrategy(value.deployStrategy)) parsed.deployStrategy = value.deployStrategy
  if (isMigrationStatus(value.migrations)) parsed.migrations = value.migrations
  for (const key of INTEGER_KEYS) {
    if (isIntegerInRange(value[key], DEPLOY_INTEGER_LIMITS[key])) parsed[key] = value[key] as number
  }
  return parsed
}

/**
 * Effective settings: environment value, else project value (tuning knobs
 * only), else the default. An environment with no stored strategy resolves to
 * `inplace` (today's behaviour); the migration status defaults to `unknown`.
 */
export function resolveDeployOptions(
  environmentOptions: unknown,
  projectOptions?: unknown
): ResolvedDeployOptions {
  const env = parseDeployOptions(environmentOptions)
  const proj = parseDeployOptions(projectOptions)
  return {
    deployStrategy: env.deployStrategy ?? DEFAULT_DEPLOY_STRATEGY,
    migrations: env.migrations ?? DEFAULT_MIGRATION_STATUS,
    drainSeconds:
      env.drainSeconds ?? proj.drainSeconds ?? DEPLOY_INTEGER_LIMITS.drainSeconds.default,
    healthTimeoutSeconds:
      env.healthTimeoutSeconds ??
      proj.healthTimeoutSeconds ??
      DEPLOY_INTEGER_LIMITS.healthTimeoutSeconds.default,
    rollbackWindowMinutes:
      env.rollbackWindowMinutes ??
      proj.rollbackWindowMinutes ??
      DEPLOY_INTEGER_LIMITS.rollbackWindowMinutes.default,
  }
}

/**
 * Create-time default: a new environment is `sequential` unless the caller
 * chose a strategy. Returns the options to persist (never mutates the input).
 */
export function stampNewEnvironmentDeployOptions(
  options: Record<string, unknown> | null
): Record<string, unknown> {
  const base = options ?? {}
  if (base.deployStrategy !== undefined) return base
  return { ...base, deployStrategy: NEW_ENVIRONMENT_DEPLOY_STRATEGY }
}
