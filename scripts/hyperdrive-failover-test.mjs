#!/usr/bin/env node
/**
 * Failover test for the cached database connection.
 *
 * Question it answers: while the panel database is down, does a cached read
 * still answer (from the cache, or from the primary connection after a
 * fallback), does it fail cleanly, and how long after the database returns
 * does the route recover?
 *
 * Run it against a TESTING deployment only, never staging or live. It stops and
 * starts the database through two commands you give it, so it can run against
 * any way of stopping that database.
 *
 *   COOKIE='tp_session=...' node scripts/hyperdrive-failover-test.mjs \
 *     --base-url https://testing.example.invalid \
 *     --stop-cmd 'ssh db-host sudo systemctl stop postgresql' \
 *     --start-cmd 'ssh db-host sudo systemctl start postgresql'
 *
 * Options:
 *   --path        route to read (default /api/client/v1/servers, the cached servers list)
 *   --cookie-env  name of the environment variable holding the Cookie header (default COOKIE);
 *                 the value is never printed
 *   --warm        warm-up requests before stopping (default 3)
 *   --down-at     seconds after the stop to read at (default 0,5,30,80; 80 is past the cache window)
 *   --up-at       seconds after the start to read at (default 0,5,15,30,60)
 *   --out         write the full result as JSON to this file
 *
 * The result table and the summary say, per step: HTTP status, time taken and
 * whether the body is the same as the warm-up body. Then the summary states
 * whether reads were served while down, until when, and how long recovery took.
 * Also read the `db-usage` log lines of the Worker over the same period (Workers
 * Logs): `fallback` counts show which reads went to the primary connection.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export function parseArgs(argv) {
  const out = {
    path: '/api/client/v1/servers',
    cookieEnv: 'COOKIE',
    warm: 3,
    downAt: [0, 5, 30, 80],
    upAt: [0, 5, 15, 30, 60],
  }
  const list = (v) => v.split(',').map((n) => Number(n))
  if (argv.includes('--help')) out.help = true
  for (let i = 0; i < argv.length && !out.help; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`missing value for ${key}`)
    if (key === '--base-url') out.baseUrl = value
    else if (key === '--path') out.path = value
    else if (key === '--stop-cmd') out.stopCmd = value
    else if (key === '--start-cmd') out.startCmd = value
    else if (key === '--cookie-env') out.cookieEnv = value
    else if (key === '--warm') out.warm = Number(value)
    else if (key === '--down-at') out.downAt = list(value)
    else if (key === '--up-at') out.upAt = list(value)
    else if (key === '--out') out.out = value
    else throw new Error(`unknown option ${key}`)
  }
  if (out.help) return out
  if (!Number.isInteger(out.warm) || out.warm < 1)
    throw new Error('--warm must be a whole number, 1 or more')
  for (const [name, list] of [
    ['--down-at', out.downAt],
    ['--up-at', out.upAt],
  ]) {
    const ok =
      list.length > 0 &&
      list.every((n, i) => Number.isFinite(n) && n >= 0 && (i === 0 || n > list[i - 1]))
    if (!ok) throw new Error(`${name} must be increasing, non-negative seconds, like 0,5,30`)
  }
  for (const required of ['baseUrl', 'stopCmd', 'startCmd']) {
    if (!out[required])
      throw new Error(`missing --${required.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`)
  }
  return out
}

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** One timed read. Never throws: a failure is a result. */
export async function readOnce({ fetchImpl, url, cookie, now = () => Date.now() }) {
  const started = now()
  try {
    const res = await fetchImpl(url, {
      headers: cookie ? { cookie } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    const body = await res.text()
    return { status: res.status, ms: now() - started, bodyHash: hash(body) }
  } catch (err) {
    return { status: 0, ms: now() - started, bodyHash: null, error: String(err?.message ?? err) }
  }
}

/** Reads at the given offsets (seconds from `phaseStart`). */
async function readAt(offsets, ctx, phase) {
  const steps = []
  for (const offset of offsets) {
    const wait = offset * 1000 - (ctx.now() - ctx.phaseStart)
    if (wait > 0) await ctx.sleep(wait)
    steps.push({ phase, atSeconds: offset, ...(await readOnce(ctx)) })
  }
  return steps
}

export async function runScenario(opts, deps) {
  const ctx = {
    fetchImpl: deps.fetchImpl,
    url: new URL(opts.path, opts.baseUrl).toString(),
    cookie: deps.cookie,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    phaseStart: 0,
  }
  const steps = []
  for (let i = 0; i < opts.warm; i++)
    steps.push({ phase: 'warm', atSeconds: i, ...(await readOnce(ctx)) })
  const baseline = steps.at(-1)?.bodyHash ?? null
  if (!steps.every((s) => s.status >= 200 && s.status < 300)) {
    throw new Error(
      `warm-up reads were not all 2xx (${steps.map((s) => s.status).join(', ')}); check the URL and cookie. The database was not touched.`
    )
  }

  // The database is always started again, even when a step fails or the run is cancelled.
  let stopped = false
  try {
    deps.run(opts.stopCmd)
    stopped = true
    ctx.phaseStart = ctx.now()
    steps.push(...(await readAt(opts.downAt, ctx, 'down')))
  } finally {
    if (stopped || deps.alwaysStart) deps.run(opts.startCmd)
  }
  ctx.phaseStart = ctx.now()
  steps.push(...(await readAt(opts.upAt, ctx, 'up')))

  return { url: ctx.url, baseline, steps, summary: summarise(steps, baseline) }
}

export function summarise(steps, baseline) {
  const ok = (s) => s.status >= 200 && s.status < 300
  const down = steps.filter((s) => s.phase === 'down')
  const up = steps.filter((s) => s.phase === 'up')
  const servedWhileDown = down.filter(ok)
  const lastServed = servedWhileDown.at(-1)
  const firstFailedDown = down.find((s) => !ok(s))
  const recovered = up.find(ok)
  const sameBody = (list) => list.every((s) => s.bodyHash === baseline)
  return {
    servedWhileDown: servedWhileDown.length > 0,
    servedWhileDownSameAsWarm: servedWhileDown.length > 0 && sameBody(servedWhileDown),
    lastServedSecondsAfterStop: lastServed ? lastServed.atSeconds : null,
    firstFailureSecondsAfterStop: firstFailedDown ? firstFailedDown.atSeconds : null,
    failureStatuses: [...new Set(down.filter((s) => !ok(s)).map((s) => s.status))],
    recoveredSecondsAfterStart: recovered ? recovered.atSeconds : null,
    neverRecovered: up.length > 0 && !recovered,
  }
}

export function formatReport(result) {
  const lines = [`URL: ${result.url}`, '', 'phase  at(s)  status  ms     same-as-warm']
  for (const s of result.steps) {
    lines.push(
      `${s.phase.padEnd(6)} ${String(s.atSeconds).padEnd(6)} ${String(s.status).padEnd(7)} ${String(s.ms).padEnd(6)} ${s.bodyHash === result.baseline ? 'yes' : 'no'}${s.error ? '  ' + s.error : ''}`
    )
  }
  const m = result.summary
  lines.push(
    '',
    `Served while the database was down: ${m.servedWhileDown ? 'yes' : 'no'}`,
    m.servedWhileDown
      ? `  Last good read ${m.lastServedSecondsAfterStop}s after the stop; same body as warm-up: ${m.servedWhileDownSameAsWarm ? 'yes' : 'no'}`
      : '',
    m.firstFailureSecondsAfterStop === null
      ? 'Reads never failed while down.'
      : `First failure ${m.firstFailureSecondsAfterStop}s after the stop (statuses: ${m.failureStatuses.join(', ')})`,
    m.neverRecovered
      ? 'Did NOT recover within the last read after the start.'
      : `Recovered ${m.recoveredSecondsAfterStart}s after the start.`
  )
  return lines.filter((l) => l !== '').join('\n')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0])
    return Promise.resolve()
  }
  const cookie = process.env[opts.cookieEnv]
  if (!cookie) throw new Error(`set ${opts.cookieEnv} to the session Cookie header value`)
  const run = (cmd) => {
    const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`command failed (${r.status}): ${cmd}`)
  }
  // Cancelling mid-run must not leave the database stopped.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      console.error(`\n${signal}: starting the database again`)
      try {
        run(opts.startCmd)
      } finally {
        process.exit(130)
      }
    })
  }
  return runScenario(opts, { fetchImpl: fetch, cookie, run }).then((result) => {
    console.log(formatReport(result))
    if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(result, null, 2))
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
