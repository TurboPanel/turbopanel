/**
 * The one self-hosted background tick: a 60 second timer that asks the shared
 * job table (`src/jobs/registry.ts`) which jobs are due and runs them.
 *
 * - Cadences come from `loadCadences` (env var, then the `jobs.cadences`
 *   setting, then the defaults), read once per tick.
 * - Two kinds of job. `local` jobs touch only this process (the in-memory cell
 *   maintenance, a cached value) and run on every instance. `shared` jobs work
 *   on the database or push to servers; they run only on the instance that holds
 *   the cross-instance lease, so two panel servers on one database never
 *   both run them.
 * - A job that throws is logged and the rest still run. A job that runs past the
 *   tick budget is left to finish on its own (it is skipped, never started a
 *   second time, until it settles) and the jobs after it are carried to the
 *   next tick.
 * - A tick that was late (a stalled event loop) still catches up: a job is due
 *   when any minute since the previous tick was one of its slots.
 *
 * Pure of the database and the clock (both are injected), so Deno tests drive it
 * with a fixed clock and a fake lease.
 */
import { DAEMON_CELL_MAINTAIN_MS } from '../../contracts/cell-protocol.ts'
import type { CronGates } from '../../daemon/cell/cron-gates.ts'
import { ALL_GATES_OPEN } from '../../daemon/cell/cron-gates.ts'
import {
  CRON_CADENCES,
  type CronCadenceTable,
  type CronJob,
  isDue,
  type ResolvedCadences,
} from '../../jobs/registry.ts'

/** How often the tick fires. */
export const JOB_TICK_MS = DAEMON_CELL_MAINTAIN_MS

/** How long one tick may run before the jobs not yet started are carried to the next one. */
export const JOB_TICK_BUDGET_MS = 75_000

/** Margin kept on the lease past the budget, so a holder still finishing cannot be stolen from. */
export const JOB_TICK_LEASE_MARGIN_MS = 10_000

/** Longest gap the catch-up looks back over; a longer gap counts every job as due. */
const MAX_CATCH_UP_MINUTES = 1440

/** What a job sees. */
export type TickContext = {
  /** The tick's clock reading. */
  nowMs: number
  /** The environment, read once for the whole tick. */
  env: Record<string, string | undefined>
  /** The tick's resolved cadences. */
  cadences: CronCadenceTable
  /** The tick's idle-check flags (every flag open when the read failed). Shared jobs only. */
  gates: CronGates
  /** Whether a registry job has a slot in this tick (or one since the previous tick). */
  isDue: (job: CronJob) => boolean
  /**
   * A resource opened on first use and closed once after the tick, for jobs that
   * share one (a fresh database client). The key names it.
   */
  resource: <T>(key: string, open: () => T, close: (value: T) => Promise<void> | void) => T
}

export type TickJob = {
  /** Unique label for logs. */
  name: string
  scope: 'local' | 'shared'
  /** Whether to run this tick; omitted means every tick. */
  due?: (ctx: TickContext) => boolean
  run: (ctx: TickContext) => Promise<unknown>
}

/** The lease handle: `release` is called once after the shared jobs. */
export type TickLease = { release: () => Promise<void> }

export type JobTickDeps = {
  jobs: readonly TickJob[]
  loadCadences: (
    env: Record<string, string | undefined>,
    nowMs: number
  ) => Promise<ResolvedCadences>
  /** One read of the environment per tick. */
  readEnv: () => Record<string, string | undefined>
  /** Takes the cross-instance lease; null when another instance holds it. */
  acquireLease: (nowMs: number, heldUntilMs: number) => Promise<TickLease | null>
  /** One statement answering "is there work?" for every gated family; may throw. */
  loadGates: (nowMs: number) => Promise<CronGates>
  now?: () => number
  budgetMs?: number
  log?: (level: 'warn' | 'info', message: string) => void
}

export type JobTickReport = {
  /** Jobs that ran to completion or failed, in order. */
  ran: string[]
  /** Jobs that failed. */
  failed: string[]
  /** Jobs not started because the budget ran out or the previous run was still going. */
  carried: string[]
  /** True when another instance held the lease, so no shared job ran. */
  leaseHeld: boolean
  /** True when a previous tick was still going, so nothing ran. */
  overlapped: boolean
}

export type JobTick = {
  run: () => Promise<JobTickReport>
}

const minuteOf = (ms: number): number => Math.floor(ms / 60_000)

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Resolves false when `promise` has not settled within `ms`. */
function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, ms))
    promise.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export function createJobTick(deps: JobTickDeps): JobTick {
  const now = deps.now ?? Date.now
  const budgetMs = deps.budgetMs ?? JOB_TICK_BUDGET_MS
  const log = deps.log ?? (() => {})
  const names = new Set<string>()
  for (const job of deps.jobs) {
    if (names.has(job.name)) throw new Error(`duplicate job name ${job.name}`)
    names.add(job.name)
  }
  let inFlight = false
  let previousMinute: number | null = null
  /** Jobs that were due but not started; they are due again next tick. */
  let carry = new Set<string>()
  /** Jobs whose run has not settled yet. */
  const running = new Set<string>()

  async function run(): Promise<JobTickReport> {
    const report: JobTickReport = {
      ran: [],
      failed: [],
      carried: [],
      leaseHeld: false,
      overlapped: false,
    }
    if (inFlight) {
      report.overlapped = true
      return report
    }
    inFlight = true
    const startedMs = now()
    const deadlineMs = startedMs + budgetMs
    const resources: { close: () => Promise<void> | void }[] = []
    const opened = new Map<string, unknown>()
    try {
      const env = deps.readEnv()
      const cadences = await readCadences(env, startedMs)
      const minute = minuteOf(startedMs)
      const since = previousMinute
      const slotInRange = (job: CronJob): boolean => {
        if (since === null || minute <= since) return isDue(job, startedMs, cadences)
        if (minute - since > MAX_CATCH_UP_MINUTES) return true
        for (let m = since + 1; m <= minute; m++) {
          if (isDue(job, m * 60_000, cadences)) return true
        }
        return false
      }
      const baseCtx = {
        nowMs: startedMs,
        env,
        cadences,
        isDue: slotInRange,
        resource: <T>(key: string, open: () => T, close: (value: T) => Promise<void> | void): T => {
          if (opened.has(key)) return opened.get(key) as T
          const value = open()
          opened.set(key, value)
          resources.push({ close: () => close(value) })
          return value
        },
      }
      const nextCarry = new Set<string>()

      const runJobs = async (scope: TickJob['scope'], ctx: TickContext): Promise<void> => {
        for (const job of deps.jobs) {
          if (job.scope !== scope) continue
          const due = carry.has(job.name) || (job.due ? job.due(ctx) : true)
          if (!due) continue
          if (running.has(job.name) || now() >= deadlineMs) {
            nextCarry.add(job.name)
            report.carried.push(job.name)
            continue
          }
          running.add(job.name)
          const work = (async () => job.run(ctx))()
          // `running` clears when the work settles, even after the tick gave up waiting.
          const settled = work.then(
            () => {},
            () => {}
          )
          void settled.then(() => running.delete(job.name))
          try {
            const finished = await settledWithin(work, deadlineMs - now())
            if (finished) {
              report.ran.push(job.name)
            } else {
              report.failed.push(job.name)
              log('warn', `job ${job.name} ran past the tick budget; left to finish`)
            }
          } catch (err) {
            report.ran.push(job.name)
            report.failed.push(job.name)
            log('warn', `job ${job.name} failed: ${errorText(err)}`)
          }
        }
      }

      // Local jobs first: they must run on every instance, lease or not.
      await runJobs('local', { ...baseCtx, gates: ALL_GATES_OPEN })

      let lease: TickLease | null = null
      try {
        lease = await deps.acquireLease(startedMs, deadlineMs + JOB_TICK_LEASE_MARGIN_MS)
      } catch (err) {
        log('warn', `job tick lease could not be taken: ${errorText(err)}`)
        carry = nextCarry
        return report
      }
      if (!lease) {
        report.leaseHeld = true
        // Another instance runs the shared jobs; do not keep claims on them.
        carry = new Set(
          [...nextCarry].filter((name) =>
            deps.jobs.some((j) => j.name === name && j.scope === 'local')
          )
        )
        return report
      }
      try {
        let gates = ALL_GATES_OPEN
        try {
          gates = await deps.loadGates(startedMs)
        } catch (err) {
          log('warn', `job gates could not be read, every family stays open: ${errorText(err)}`)
        }
        await runJobs('shared', { ...baseCtx, gates })
      } finally {
        try {
          await lease.release()
        } catch (err) {
          log('warn', `job tick lease could not be released: ${errorText(err)}`)
        }
      }
      carry = nextCarry
      return report
    } finally {
      previousMinute = minuteOf(startedMs)
      for (const resource of resources) {
        try {
          await resource.close()
        } catch (err) {
          log('warn', `job tick resource close failed: ${errorText(err)}`)
        }
      }
      inFlight = false
    }
  }

  async function readCadences(
    env: Record<string, string | undefined>,
    nowMs: number
  ): Promise<CronCadenceTable> {
    try {
      const resolved = await deps.loadCadences(env, nowMs)
      if (resolved.warnings.length > 0) log('warn', `job cadences: ${resolved.warnings.join('; ')}`)
      return resolved.table
    } catch (err) {
      log('warn', `job cadences could not be read, defaults used: ${errorText(err)}`)
      return CRON_CADENCES
    }
  }

  return { run }
}
