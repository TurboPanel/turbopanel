/**
 * Plans and runs checks one after another. Each check gets its own cleanup
 * stack, unwound LIFO in `finally` whether the check passed, failed or threw;
 * a failing cleanup step never stops the steps after it.
 */
import { redactText, safetyPermits, type SafetyFlags } from './safety.ts'
import type {
  Api,
  Capability,
  Check,
  CheckContext,
  CheckOutcome,
  CheckResult,
  Cleanup,
  MailSink,
  SessionClient,
  SshExec,
} from './types.ts'

export interface PlanOptions extends SafetyFlags {
  /** Run only these row ids (`--only`). Empty means every row. */
  only: string[]
  /** Capabilities this run can offer (`api`, `mail`, `ssh:<host>`). */
  available: ReadonlySet<Capability>
}

export interface PlannedCheck {
  check: Check
  run: boolean
  reason: string
}

export function planChecks(registry: readonly Check[], options: PlanOptions): PlannedCheck[] {
  return registry
    .filter((check) => options.only.length === 0 || options.only.includes(check.rowId))
    .map((check) => ({ check, ...decide(check, options) }))
}

function decide(check: Check, options: PlanOptions): { run: boolean; reason: string } {
  const missing = check.requires.filter((cap) => !options.available.has(cap))
  if (missing.length > 0) return { run: false, reason: `missing capability: ${missing.join(', ')}` }
  if (!options.apply) return { run: false, reason: 'dry run (pass --apply to execute)' }
  if (safetyPermits(check.safety, options)) return { run: true, reason: 'selected' }
  if (check.safety === 'host-affecting' && !options.allowHostAffecting) {
    return { run: false, reason: 'host-affecting (needs --allow-host-affecting)' }
  }
  return { run: false, reason: `above --safety ${options.maxSafety}` }
}

export interface RunDeps {
  api: Api
  mail?: MailSink
  ssh?: SshExec
  session?: () => SessionClient
  prefix: string
  hosts: string[]
  sshHosts: string[]
  sleep(ms: number): Promise<void>
  probe(url: string): Promise<number>
  log(message: string): void
  /** Set by the SIGINT handler: later checks skip, a running check stops at its next wait. */
  interrupt?: Interrupt
}

export interface Interrupt {
  requested: boolean
}

export class InterruptedError extends Error {
  override name = 'InterruptedError'
}

export interface RunReport {
  results: CheckResult[]
  /** Cleanup steps that failed; each is an object the run may have left behind. */
  leftovers: string[]
}

/** Run the planned checks in order; skipped ones are reported with their reason. */
export async function runPlan(plan: readonly PlannedCheck[], deps: RunDeps): Promise<RunReport> {
  const report: RunReport = { results: [], leftovers: [] }
  await plan.reduce<Promise<void>>(async (previous, item) => {
    await previous
    const result =
      item.run && !deps.interrupt?.requested
        ? await runOne(item.check, deps, report.leftovers)
        : { id: item.check.rowId, verdict: 'skip' as const, evidence: skipReason(item, deps) }
    report.results.push(result)
  }, Promise.resolve())
  return report
}

function skipReason(item: PlannedCheck, deps: RunDeps): string {
  return item.run && deps.interrupt?.requested ? 'interrupted (SIGINT)' : item.reason
}

export async function runOne(
  check: Check,
  deps: RunDeps,
  leftovers: string[]
): Promise<CheckResult> {
  const stack: { label: string; step: Cleanup }[] = []
  let unwinding = false
  const sleep = async (ms: number): Promise<void> => {
    if (deps.interrupt?.requested && !unwinding) throw new InterruptedError('interrupted (SIGINT)')
    await deps.sleep(ms)
  }
  const ctx: CheckContext = {
    api: deps.api,
    mail: deps.mail,
    ssh: deps.ssh,
    session: deps.session,
    prefix: deps.prefix,
    hosts: deps.hosts,
    sshHosts: deps.sshHosts,
    sleep,
    probe: deps.probe,
    log: (message) => deps.log(`[${check.rowId}] ${message}`),
    defer: (label, step) => void stack.push({ label, step }),
  }
  let outcome: CheckOutcome
  try {
    deps.log(`[${check.rowId}] start (${check.safety})`)
    outcome = await check.run(ctx)
  } catch (error) {
    outcome = { verdict: 'fail', evidence: `error: ${errorText(error)}` }
  } finally {
    unwinding = true
    const failed = await unwind(stack, deps.log)
    leftovers.push(...failed.map((label) => `${check.rowId}: ${label}`))
    if (failed.length > 0) deps.log(`[${check.rowId}] cleanup failed: ${failed.join('; ')}`)
  }
  return { id: check.rowId, verdict: outcome.verdict, evidence: redactText(outcome.evidence) }
}

/** Run every cleanup step LIFO; return the labels of the steps that threw. */
export async function unwind(
  stack: { label: string; step: Cleanup }[],
  log: (message: string) => void
): Promise<string[]> {
  const failed: string[] = []
  await [...stack].reverse().reduce<Promise<void>>(async (previous, { label, step }) => {
    await previous
    try {
      await step()
    } catch (error) {
      failed.push(`${label} (${errorText(error)})`)
      log(`cleanup "${label}" failed: ${errorText(error)}`)
    }
  }, Promise.resolve())
  return failed
}

export function errorText(error: unknown): string {
  return redactText(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
}

/** A short, unique prefix for everything one run creates: `clr-<base36 time><rand>`. */
export function runPrefix(now: Date, random: () => number = Math.random): string {
  const time = now.getTime().toString(36).slice(-5)
  const tail = Math.floor(random() * 36 ** 3)
    .toString(36)
    .padStart(3, '0')
  return `clr-${time}${tail}`
}

export interface SummaryMeta {
  target: string
  environment: string
  prefix: string
  apply: boolean
  startedAt: string
  finishedAt: string
}

export function toMarkdown(report: RunReport, meta: SummaryMeta): string {
  const count = (v: string) => report.results.filter((r) => r.verdict === v).length
  const lines = [
    `# Checklist run ${meta.prefix}`,
    '',
    `- Target: ${meta.target} (environment \`${meta.environment}\`)`,
    `- Mode: ${meta.apply ? 'apply' : 'dry run'}`,
    `- Started ${meta.startedAt}, finished ${meta.finishedAt}`,
    `- pass ${count('pass')} / fail ${count('fail')} / skip ${count('skip')}`,
    '',
    '| Row | Verdict | Evidence |',
    '| --- | --- | --- |',
    ...report.results.map((r) => `| ${r.id} | ${r.verdict} | ${cell(r.evidence)} |`),
  ]
  if (report.leftovers.length > 0) {
    lines.push('', '## Cleanup failures (check these by hand)', '')
    lines.push(...report.leftovers.map((l) => `- ${l}`))
  }
  return `${lines.join('\n')}\n`
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

/**
 * Road page status docs, one JSON line each, for the orchestrator to apply to
 * the Road page database (collection `status`, doc id = row id). Skips are
 * never emitted, so a skipped check cannot overwrite a recorded verdict.
 */
export function roadLines(results: readonly CheckResult[], prefix: string, now: Date): string[] {
  return results
    .filter((r) => r.verdict !== 'skip')
    .map((r) =>
      JSON.stringify({
        action: 'set',
        collection: 'status',
        doc_id: r.id,
        data: {
          state: r.verdict,
          note: `checklist-runner ${prefix}: ${r.evidence}`.slice(0, 900),
          updatedAt: now.toISOString(),
        },
      })
    )
}
