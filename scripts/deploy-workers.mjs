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
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
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
    runDeploy()
  } catch (err) {
    console.error(`deploy-workers: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
