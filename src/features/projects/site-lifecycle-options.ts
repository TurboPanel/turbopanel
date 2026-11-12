/**
 * A PHP site's post-deploy commands and background workers, as kept in
 * `service.options`.
 *
 * Commands are written as one command line each and run directly, with no
 * shell (see `parseCronCommand`). Post-deploy commands may run again when a
 * deploy is retried, so they should be safe to run more than once.
 *
 * The write route runs `validateSiteLifecycleOptions` on the raw options
 * before they are parsed, because `parseServiceOptions` drops what it cannot
 * read and a bad worker would otherwise vanish with a success answer.
 */
import { CRON_JOB_NAME_RE, parseCronCommand } from '../deploy/cron.ts'
import type { ServiceOptions } from './service-options.ts'

export const MAX_POST_DEPLOY_COMMANDS = 10
export const MIN_POST_DEPLOY_TIMEOUT_SECONDS = 30
export const MAX_POST_DEPLOY_TIMEOUT_SECONDS = 1800
export const MAX_SITE_WORKERS = 10
export const MAX_WORKER_PROCESSES = 8
export const MIN_WORKER_STOP_TIMEOUT_SECONDS = 10
export const MAX_WORKER_STOP_TIMEOUT_SECONDS = 3600
export const MIN_WORKER_MEMORY_MB = 64
export const MAX_WORKER_MEMORY_MB = 64 * 1024

/** Said wherever commands are described. */
export const POST_DEPLOY_RETRY_NOTE =
  'A retried deploy can run post-deploy commands again, so they should be safe to run more than once.'

type SiteWorkerOption = NonNullable<ServiceOptions['workers']>[number]
type SiteLifecycleFields = Pick<
  ServiceOptions,
  'postDeployCommands' | 'postDeployTimeoutSeconds' | 'postDeployTiming' | 'workers'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** What a stored worker keeps: only fields that read cleanly. Null when the entry is unusable. */
function readWorker(raw: unknown): SiteWorkerOption | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.command !== 'string') {
    return null
  }
  const name = raw.name.trim()
  const command = raw.command.trim()
  if (!CRON_JOB_NAME_RE.test(name) || command.length === 0) return null
  const worker: SiteWorkerOption = { name, command }
  if (isIntegerInRange(raw.processes, 1, MAX_WORKER_PROCESSES)) worker.processes = raw.processes
  if (
    isIntegerInRange(
      raw.stopTimeoutSeconds,
      MIN_WORKER_STOP_TIMEOUT_SECONDS,
      MAX_WORKER_STOP_TIMEOUT_SECONDS
    )
  ) {
    worker.stopTimeoutSeconds = raw.stopTimeoutSeconds
  }
  if (isIntegerInRange(raw.memoryMb, MIN_WORKER_MEMORY_MB, MAX_WORKER_MEMORY_MB)) {
    worker.memoryMb = raw.memoryMb
  }
  if (raw.enabled === false) worker.enabled = false
  return worker
}

function readWorkers(value: unknown): SiteWorkerOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const workers: SiteWorkerOption[] = []
  for (const raw of value) {
    const worker = readWorker(raw)
    if (worker === null || seen.has(worker.name)) continue
    seen.add(worker.name)
    workers.push(worker)
    if (workers.length >= MAX_SITE_WORKERS) break
  }
  return workers.length > 0 ? workers : undefined
}

function readCommands(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const commands = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_POST_DEPLOY_COMMANDS)
  return commands.length > 0 ? commands : undefined
}

/** The lifecycle fields of a stored options document; unreadable parts are dropped. */
export function readSiteLifecycleOptions(value: Record<string, unknown>): SiteLifecycleFields {
  const out: SiteLifecycleFields = {}
  const commands = readCommands(value.postDeployCommands)
  if (commands) out.postDeployCommands = commands
  if (
    isIntegerInRange(
      value.postDeployTimeoutSeconds,
      MIN_POST_DEPLOY_TIMEOUT_SECONDS,
      MAX_POST_DEPLOY_TIMEOUT_SECONDS
    )
  ) {
    out.postDeployTimeoutSeconds = value.postDeployTimeoutSeconds
  }
  if (value.postDeployTiming === 'before-traffic' || value.postDeployTiming === 'after-switch') {
    out.postDeployTiming = value.postDeployTiming
  }
  const workers = readWorkers(value.workers)
  if (workers) out.workers = workers
  return out
}

function commandProblem(label: string, command: unknown): string | null {
  const parsed = parseCronCommand(command)
  return parsed.ok ? null : `${label}: ${parsed.error}`
}

function postDeployProblem(options: Record<string, unknown>): string | null {
  const commands = options.postDeployCommands
  if (commands !== undefined) {
    if (!Array.isArray(commands) || commands.length > MAX_POST_DEPLOY_COMMANDS) {
      return `Post-deploy commands must be a list of at most ${MAX_POST_DEPLOY_COMMANDS} commands.`
    }
    for (const [index, command] of commands.entries()) {
      const problem = commandProblem(`Post-deploy command ${index + 1}`, command)
      if (problem) return problem
    }
  }
  const timeout = options.postDeployTimeoutSeconds
  if (
    timeout !== undefined &&
    !isIntegerInRange(timeout, MIN_POST_DEPLOY_TIMEOUT_SECONDS, MAX_POST_DEPLOY_TIMEOUT_SECONDS)
  ) {
    return `The post-deploy time limit must be a whole number of seconds from ${MIN_POST_DEPLOY_TIMEOUT_SECONDS} to ${MAX_POST_DEPLOY_TIMEOUT_SECONDS}.`
  }
  const timing = options.postDeployTiming
  if (timing !== undefined && timing !== 'before-traffic' && timing !== 'after-switch') {
    return 'Post-deploy commands run either before the new release takes traffic or right after the switch.'
  }
  return null
}

const WORKER_NUMBER_RULES: ReadonlyArray<readonly [string, string, number, number]> = [
  ['processes', 'process count', 1, MAX_WORKER_PROCESSES],
  [
    'stopTimeoutSeconds',
    'stop time limit',
    MIN_WORKER_STOP_TIMEOUT_SECONDS,
    MAX_WORKER_STOP_TIMEOUT_SECONDS,
  ],
  ['memoryMb', 'memory limit in megabytes', MIN_WORKER_MEMORY_MB, MAX_WORKER_MEMORY_MB],
]

function workerProblem(raw: unknown, seen: Set<string>): string | null {
  if (!isRecord(raw)) return 'Each worker must be an object with a name and a command.'
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!CRON_JOB_NAME_RE.test(name)) {
    return 'A worker name uses lowercase letters, digits and dashes, starts with a letter or digit, and is at most 32 characters.'
  }
  if (seen.has(name)) return `Worker names must be unique: "${name}" is used twice.`
  seen.add(name)
  const problem = commandProblem(`Worker "${name}"`, raw.command)
  if (problem) return problem
  for (const [key, label, min, max] of WORKER_NUMBER_RULES) {
    if (raw[key] !== undefined && !isIntegerInRange(raw[key], min, max)) {
      return `Worker "${name}": the ${label} must be a whole number from ${min} to ${max}.`
    }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return `Worker "${name}": enabled must be true or false.`
  }
  return null
}

function workersProblem(options: Record<string, unknown>): string | null {
  const workers = options.workers
  if (workers === undefined) return null
  if (!Array.isArray(workers) || workers.length > MAX_SITE_WORKERS) {
    return `Workers must be a list of at most ${MAX_SITE_WORKERS} workers.`
  }
  const seen = new Set<string>()
  for (const raw of workers) {
    const problem = workerProblem(raw, seen)
    if (problem) return problem
  }
  return null
}

/** A plain sentence when the raw options hold commands or workers the wire cannot carry, else null. */
export function validateSiteLifecycleOptions(options: unknown): string | null {
  if (!isRecord(options)) return null
  return postDeployProblem(options) ?? workersProblem(options)
}

/** Whether saved options carry commands or workers that would be sent. */
export function hasSiteLifecycle(options: ServiceOptions | null | undefined): boolean {
  if (!options) return false
  return (
    (options.postDeployCommands?.length ?? 0) > 0 ||
    (options.workers ?? []).some((worker) => worker.enabled !== false)
  )
}
