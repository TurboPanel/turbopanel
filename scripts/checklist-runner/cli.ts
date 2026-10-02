#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run=ssh
/**
 * Testing Checklist live-proof runner. Dry run by default; see README.md.
 *
 *   set -a; . ~/.claude/test-creds.env; set +a
 *   deno run -A scripts/checklist-runner/cli.ts                      # plan only
 *   deno run -A scripts/checklist-runner/cli.ts --apply --safety readonly
 */
import { mailpitSink, portProbe, sshExec } from './adapters.ts'
import { REGISTRY } from './checks/index.ts'
import { ApiClient, type FetchLike } from './http.ts'
import { acquireLock, denoLockFs, type Lock, type LockFs } from './lock.ts'
import {
  planChecks,
  roadLines,
  runPlan,
  runPrefix,
  toMarkdown,
  type Interrupt,
  type RunReport,
} from './runner.ts'
import { SAFETY_ORDER, assertHealthEnvironment, assertTargetUrl } from './safety.ts'
import type { Capability, Check, Json, Safety } from './types.ts'

export interface CliOptions {
  target: 'testing' | 'canary'
  apply: boolean
  allowHostAffecting: boolean
  maxSafety: Safety
  only: string[]
  hosts: string[]
  sshHosts: string[]
  outDir: string
  tickRoad: boolean
  lockPath: string
  list: boolean
}

export class UsageError extends Error {
  override name = 'UsageError'
}

const VALUE_FLAGS = new Set(['--target', '--safety', '--only', '--host', '--ssh-host', '--out'])

export function parseArgs(argv: readonly string[], tmpDir: string): CliOptions {
  const opts: CliOptions = {
    target: 'testing',
    apply: false,
    allowHostAffecting: false,
    maxSafety: 'creates-objects',
    only: [],
    hosts: [],
    sshHosts: [],
    outDir: `${tmpDir}/turbopanel-checklist-runs`,
    tickRoad: false,
    lockPath: `${tmpDir}/turbopanel-checklist-runner.lock`,
    list: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? ''
    if (VALUE_FLAGS.has(flag)) applyValue(opts, flag, argv[++i])
    else applySwitch(opts, flag)
  }
  if (opts.allowHostAffecting && !opts.apply) {
    throw new UsageError('--allow-host-affecting needs --apply')
  }
  if (opts.allowHostAffecting && !argv.includes('--safety')) opts.maxSafety = 'host-affecting'
  return opts
}

function applySwitch(opts: CliOptions, flag: string): void {
  const switches: Record<string, () => void> = {
    '--apply': () => (opts.apply = true),
    '--allow-host-affecting': () => (opts.allowHostAffecting = true),
    '--tick-road': () => (opts.tickRoad = true),
    '--list': () => (opts.list = true),
  }
  const set = switches[flag]
  if (!set) throw new UsageError(`unknown flag ${flag}`)
  set()
}

function applyValue(opts: CliOptions, flag: string, value: string | undefined): void {
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`)
  if (flag === '--target') opts.target = parseTarget(value)
  else if (flag === '--safety') opts.maxSafety = parseSafety(value)
  else if (flag === '--only') opts.only.push(...value.split(',').filter(Boolean))
  else if (flag === '--host') opts.hosts.push(value)
  else if (flag === '--ssh-host') opts.sshHosts.push(value)
  else opts.outDir = value
}

function parseTarget(value: string): 'testing' | 'canary' {
  if (value === 'testing' || value === 'canary') return value
  throw new UsageError(`--target must be testing or canary, got ${value}`)
}

function parseSafety(value: string): Safety {
  const found = SAFETY_ORDER.find((s) => s === value)
  if (!found) throw new UsageError(`--safety must be one of ${SAFETY_ORDER.join(', ')}`)
  return found
}

export interface TargetEnv {
  url: string
  email: string
  password: string
  mailpitUrl?: string
  sshUser?: string
  sshIdentity?: string
}

/** Credentials come from the process environment only (`TESTING_*` or `CANARY_*`). */
export function readTargetEnv(
  target: 'testing' | 'canary',
  env: (k: string) => string | undefined
) {
  const p = target.toUpperCase()
  const url = env(`${p}_URL`)
  const email = env(`${p}_EMAIL`)
  const password = env(`${p}_PASSWORD`)
  if (!url) throw new UsageError(`${p}_URL is not set (set -a; . <creds file>; set +a)`)
  const out: TargetEnv = { url: assertTargetUrl(url), email: email ?? '', password: password ?? '' }
  out.mailpitUrl = env('MAILPIT_URL') || undefined
  out.sshUser = env('CHECKLIST_SSH_USER') || undefined
  out.sshIdentity = env('CHECKLIST_SSH_IDENTITY') || undefined
  return out
}

export function availableCapabilities(opts: CliOptions, env: TargetEnv): Set<Capability> {
  const caps = new Set<Capability>(['api'])
  if (env.mailpitUrl) caps.add('mail')
  for (const host of opts.sshHosts) caps.add(`ssh:${host}`)
  return caps
}

export interface MainDeps {
  fetch: FetchLike
  env: (key: string) => string | undefined
  now: () => Date
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  print: (line: string) => void
  writeFile: (path: string, text: string) => Promise<void>
  mkdir: (path: string) => Promise<void>
  lockFs: LockFs
  tmpDir: string
  registry?: readonly Check[]
  /** Subscribe to SIGINT; returns the unsubscribe function. */
  onInterrupt?: (handler: () => void) => () => void
  /** Hard exit on a second SIGINT (no cleanup). */
  exit?: (code: number) => void
}

/** First SIGINT: finish the current check's cleanup, skip the rest. Second: exit now. */
function handleInterrupt(interrupt: Interrupt, deps: MainDeps): void {
  if (!interrupt.requested) {
    interrupt.requested = true
    deps.log('interrupt: cleaning up the current check, skipping the rest (Ctrl-C again aborts)')
    return
  }
  deps.log('second interrupt: exiting WITHOUT cleanup; check the run prefix for leftovers')
  deps.exit?.(130)
}

/** Exit code: 0 all good, 1 a check failed, 2 refused or usage error. */
export async function main(argv: readonly string[], deps: MainDeps): Promise<number> {
  const opts = parseArgs(argv, deps.tmpDir)
  const registry = deps.registry ?? REGISTRY
  if (opts.list) {
    registry.forEach((c) => deps.print(`${c.rowId}\t${c.safety}\t${c.requires.join(',')}`))
    return 0
  }
  const target = readTargetEnv(opts.target, deps.env)
  const environment = await checkHealth(target.url, deps.fetch)
  deps.log(`target ${target.url} reports environment "${environment}"`)
  const lock: Lock | undefined = opts.apply
    ? await acquireLock(opts.lockPath, deps.lockFs)
    : undefined
  const interrupt: Interrupt = { requested: false }
  const stopListening = deps.onInterrupt?.(() => handleInterrupt(interrupt, deps))
  try {
    return await execute(opts, { target, environment, registry, interrupt }, deps)
  } finally {
    stopListening?.()
    await lock?.release()
  }
}

async function checkHealth(origin: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(`${origin}/api/health`, { method: 'GET', redirect: 'manual' })
  const text = await res.text()
  let body: Json = null
  try {
    body = JSON.parse(text) as Json
  } catch {
    body = null
  }
  return assertHealthEnvironment(res.status, body, new URL(origin).hostname)
}

interface RunInputs {
  target: TargetEnv
  environment: string
  registry: readonly Check[]
  interrupt: Interrupt
}

async function execute(opts: CliOptions, inputs: RunInputs, deps: MainDeps): Promise<number> {
  const { target, environment, registry, interrupt } = inputs
  const startedAt = deps.now()
  const prefix = runPrefix(startedAt)
  const plan = planChecks(registry, {
    ...opts,
    available: availableCapabilities(opts, target),
  })
  plan.forEach((p) =>
    deps.log(`${p.run ? 'RUN ' : 'skip'} ${p.check.rowId} [${p.check.safety}] ${p.reason}`)
  )
  const report = opts.apply
    ? await applyPlan(plan, opts, { target, prefix, interrupt }, deps)
    : await runPlan(plan, {
        ...noApi(),
        prefix,
        hosts: opts.hosts,
        sshHosts: opts.sshHosts,
        sleep: deps.sleep,
        log: deps.log,
      })
  const meta = {
    target: target.url,
    environment,
    prefix,
    apply: opts.apply,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
  }
  await writeOutputs(report, meta, opts, deps)
  return report.results.some((r) => r.verdict === 'fail') ? 1 : 0
}

async function applyPlan(
  plan: ReturnType<typeof planChecks>,
  opts: CliOptions,
  run: { target: TargetEnv; prefix: string; interrupt: Interrupt },
  deps: MainDeps
): Promise<RunReport> {
  const { target, prefix, interrupt } = run
  if (!target.email || !target.password) throw new UsageError('credentials missing for --apply')
  const api = new ApiClient({
    origin: target.url,
    fetch: deps.fetch,
    readOnly: opts.maxSafety === 'readonly',
    sleep: deps.sleep,
  })
  await api.signIn({ email: target.email, password: target.password })
  if (!api.orgId) throw new Error('signed in, but no organization is listed')
  const mail = target.mailpitUrl ? mailpitSink(target.mailpitUrl, deps.fetch) : undefined
  const ssh =
    opts.sshHosts.length > 0
      ? sshExec({ allowed: opts.sshHosts, user: target.sshUser, identity: target.sshIdentity })
      : undefined
  const probe = portProbe(deps.fetch)
  const session = () => api.fork()
  return runPlan(plan, {
    api,
    mail,
    ssh,
    probe,
    session,
    prefix,
    hosts: opts.hosts,
    sshHosts: opts.sshHosts,
    sleep: deps.sleep,
    log: deps.log,
    interrupt,
  })
}

/** A dry run never builds a client; every check is skipped before it could use one. */
function noApi() {
  const refuse = () => Promise.reject(new Error('dry run: no API client'))
  const api = { orgId: '', get: refuse, post: refuse, put: refuse, patch: refuse, del: refuse }
  return { api, probe: refuse }
}

async function writeOutputs(
  report: RunReport,
  meta: Parameters<typeof toMarkdown>[1],
  opts: CliOptions,
  deps: MainDeps
): Promise<void> {
  await deps.mkdir(opts.outDir)
  const base = `${opts.outDir}/results-${meta.prefix}`
  await deps.writeFile(`${base}.json`, `${JSON.stringify(report.results, null, 1)}\n`)
  const markdown = toMarkdown(report, meta)
  await deps.writeFile(`${base}.md`, markdown)
  deps.print(markdown)
  if (!opts.tickRoad) return
  const lines = roadLines(report.results, meta.prefix, deps.now())
  await deps.writeFile(`${base}.road.jsonl`, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  deps.print('--- road status docs (collection "status"; apply with ArtifactData) ---')
  lines.forEach((line) => deps.print(line))
}

if (import.meta.main) {
  const deps: MainDeps = {
    fetch: (input, init) => fetch(input, init),
    env: (key) => Deno.env.get(key),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.error(line),
    print: (line) => console.log(line),
    writeFile: (path, text) => Deno.writeTextFile(path, text),
    mkdir: (path) => Deno.mkdir(path, { recursive: true }),
    lockFs: denoLockFs,
    onInterrupt: (handler) => {
      Deno.addSignalListener('SIGINT', handler)
      return () => Deno.removeSignalListener('SIGINT', handler)
    },
    exit: (code) => Deno.exit(code),
    tmpDir: Deno.env.get('TMPDIR')?.replace(/\/$/, '') || '/tmp',
  }
  main(Deno.args, deps).then(
    (code) => Deno.exit(code),
    (error) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      Deno.exit(2)
    }
  )
}
