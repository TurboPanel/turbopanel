#!/usr/bin/env node
/**
 * `pnpm deploy` / `pnpm deploy:testing` — migrate the environment's database,
 * then `wrangler deploy --env <env>` with `TURBOPANEL_REVISION` stamped.
 *
 * Cloudflare Workers Builds runs `pnpm run deploy:testing` as the deploy
 * command on `trunk` for testing.turbopanel.dev (branch-based builds, the
 * same mechanism staging and live keep). Build variables it needs:
 * `TURBOPANEL_DATABASE_URL` (the migrate role's TCP URL for the testing
 * database — Hyperdrive is not reachable from the build container) and a
 * token that can read the env's Hyperdrive config for the origin check (see
 * scripts/check-deploy-env.mjs). The revision comes from Workers Builds'
 * `WORKERS_CI_COMMIT_SHA`, else `git rev-parse HEAD`; a deploy that cannot
 * name its commit is refused rather than shipping `revision: unknown`.
 *
 * Confirmation: `staging` and `live` ask first. On a terminal you type the
 * environment name; without one you must pass `--yes`
 * (`pnpm run deploy:live --yes`). Inside Workers Builds (it sets
 * `WORKERS_CI_COMMIT_SHA`, and `WORKERS_CI`) the guard is skipped so branch
 * builds keep running unattended. `testing` is never asked.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const COMMIT_RE = /^[0-9a-f]{40}$/

/** The commit to stamp: Workers Builds' SHA first, else the checkout's HEAD. */
export function resolveRevision(env, gitHead) {
  const commit = env.WORKERS_CI_COMMIT_SHA?.trim() || gitHead()
  if (!commit || !COMMIT_RE.test(commit)) {
    throw new Error(
      `cannot name the commit to stamp as TURBOPANEL_REVISION (got ${JSON.stringify(commit ?? '')})`
    )
  }
  return commit
}

const CONFIRMED_ENVS = new Set(['staging', 'live'])

/** True inside Cloudflare Workers Builds (the unattended branch deploys). */
export function isWorkersBuilds(env) {
  return Boolean(
    env.WORKERS_CI_COMMIT_SHA?.trim() || ['1', 'true'].includes(env.WORKERS_CI?.trim())
  )
}

async function askOnTerminal(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

/**
 * Throws unless a staging/live deploy is confirmed: skipped in Workers Builds
 * and for other envs; `--yes` proceeds; a terminal must type the env name;
 * anything else is refused.
 */
export async function confirmDeploy(
  env,
  argv = [],
  { isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), ask = askOnTerminal } = {}
) {
  const envName = env.CLOUDFLARE_ENV?.trim()
  if (!envName || !CONFIRMED_ENVS.has(envName) || isWorkersBuilds(env)) return
  if (argv.includes('--yes')) return
  if (!isTTY) {
    throw new Error(
      `deploying ${envName} needs confirmation: pass --yes (pnpm run deploy:${envName} --yes)`
    )
  }
  const answer = (await ask(`Deploy to ${envName}? Type "${envName}" to continue: `)).trim()
  if (answer !== envName) throw new Error(`confirmation did not match "${envName}" — not deploying`)
}

/** The ordered commands for one deploy. Throws on a missing precondition. */
export function planDeploy(env, gitHead) {
  const envName = env.CLOUDFLARE_ENV?.trim()
  if (!envName || !ENV_NAME_RE.test(envName)) {
    throw new Error('CLOUDFLARE_ENV is required (e.g. testing)')
  }
  if (!(env.TURBOPANEL_DATABASE_URL?.trim() || env.DATABASE_URL?.trim())) {
    throw new Error('TURBOPANEL_DATABASE_URL is required: the deploy migrates the database first')
  }
  const revision = resolveRevision(env, gitHead)
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  return [
    { label: 'migrate', argv: ['pnpm', 'run', 'migrate'] },
    {
      label: `wrangler deploy --env ${envName} (revision ${revision.slice(0, 8)})`,
      argv: [
        process.execPath,
        wrangler,
        'deploy',
        '--env',
        envName,
        '--minify',
        '--var',
        `TURBOPANEL_REVISION:${revision}`,
      ],
    },
  ]
}

function gitHeadFromCheckout() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

function runStep(argv, env) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, env, stdio: 'inherit' })
  return result.status ?? 1
}

/** Run the plan in order; a failed step stops the deploy. */
export function runDeploy(
  env = process.env,
  { gitHead = gitHeadFromCheckout, run = runStep } = {}
) {
  for (const step of planDeploy(env, gitHead)) {
    console.log(`deploy-workers: ${step.label}`)
    const status = run(step.argv, env)
    if (status !== 0) throw new Error(`${step.label} failed (exit ${status})`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await confirmDeploy(process.env, process.argv.slice(2))
    runDeploy()
  } catch (err) {
    console.error(`deploy-workers: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
