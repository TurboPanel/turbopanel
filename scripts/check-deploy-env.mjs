/**
 * Deploy-time environment check for `pnpm migrate` under `pnpm deploy`
 * (schema-migrate-hygiene, Road to 0.1.x): with `CLOUDFLARE_ENV` set, refuse
 * to migrate a database that is not that environment's Hyperdrive origin.
 *
 * `CLOUDFLARE_ENV=live` with a `TURBOPANEL_DATABASE_URL` that is actually
 * testing's (or the other way round) is the mistake this guards — the two
 * origins have the same schema, so nothing else would notice until data went
 * missing. Rather than inventing expected hostnames, it reads the real
 * binding: wrangler.jsonc names the `HYPERDRIVE` config id for the env, and
 * the config's origin (host, port, database — never the password) comes from
 * the Cloudflare API when `TURBOPANEL_DEPLOY_CHECK_API_TOKEN` (Workers Builds)
 * or `CLOUDFLARE_API_TOKEN` is set, else
 * `wrangler hyperdrive get` (wrangler login OAuth). The migrate URL must name
 * the same host, port, and database. The Postgres role may differ: migrate
 * runs as a dedicated user with broader grants than the Hyperdrive runtime
 * and cached-Hyperdrive roles.
 *
 * Fails closed: if `CLOUDFLARE_ENV` is set and the origin cannot be read,
 * the migrate is refused — `pnpm deploy` runs `wrangler deploy` next and
 * needs the same auth anyway. With `CLOUDFLARE_ENV` unset (CI, dev,
 * self-hosted, a plain `pnpm migrate`) the check is skipped entirely.
 *
 * Usage:
 *   node scripts/check-deploy-env.mjs        # exits 0 (skipped or matched), 1 (refused)
 * Exported for scripts/migrate-locked.mjs.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/
const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

function stripJsonc(text) {
  // wrangler.jsonc: block and line comments, trailing commas.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1')
}

export function readHyperdriveIdForEnv(envName, wranglerPath = path.join(ROOT, 'wrangler.jsonc')) {
  if (!ENV_NAME_RE.test(envName)) throw new Error(`invalid CLOUDFLARE_ENV ${JSON.stringify(envName)}`)
  const config = JSON.parse(stripJsonc(fs.readFileSync(wranglerPath, 'utf8')))
  const env = config.env?.[envName]
  if (!env) throw new Error(`wrangler.jsonc has no env.${envName}`)
  const binding = (env.hyperdrive ?? []).find((entry) => entry.binding === 'HYPERDRIVE')
  if (!binding || !HYPERDRIVE_ID_RE.test(binding.id)) {
    throw new Error(`wrangler.jsonc env.${envName} has no HYPERDRIVE binding with a config id`)
  }
  return { id: binding.id, accountId: env.vars?.CLOUDFLARE_ACCOUNT_ID ?? config.vars?.CLOUDFLARE_ACCOUNT_ID }
}

async function readOriginFromApi(accountId, id) {
  // Workers Builds keeps its own deploy token; a separate read-only
  // Hyperdrive token avoids overriding it with a same-named build variable.
  const token =
    process.env.TURBOPANEL_DEPLOY_CHECK_API_TOKEN?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim()
  if (!token || !accountId) return null
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs/${id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const body = await response.json()
  if (!response.ok || !body.success) {
    throw new Error(`Cloudflare API: ${body.errors?.[0]?.message ?? response.statusText}`)
  }
  return body.result?.origin ?? null
}

function readOriginFromWrangler(id) {
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  let output
  try {
    output = execFileSync(process.execPath, [wrangler, 'hyperdrive', 'get', id], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('wrangler hyperdrive get failed (not logged in?)')
  }
  const start = output.indexOf('{')
  if (start === -1) throw new Error('could not parse wrangler hyperdrive get output')
  return JSON.parse(output.slice(start)).origin ?? null
}

/** Host/port/database/user from a TCP postgres URL; null for socket URLs. */
export function migrateTargetFromUrl(url) {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) return null
    return {
      host: parsed.hostname.toLowerCase(),
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      user: decodeURIComponent(parsed.username),
    }
  } catch {
    return null
  }
}

export function compareTarget(target, origin) {
  const mismatches = []
  const originHost = String(origin.host ?? '').toLowerCase()
  if (target.host !== originHost) mismatches.push(`host ${target.host} ≠ ${originHost}`)
  if (target.port !== Number(origin.port ?? 5432)) mismatches.push(`port ${target.port} ≠ ${origin.port ?? 5432}`)
  if (target.database !== origin.database) mismatches.push(`database ${target.database} ≠ ${origin.database}`)
  return mismatches
}

/** Returns a one-line result; throws to refuse. */
export async function assertMigrateTargetMatchesEnv(env = process.env) {
  const envName = env.CLOUDFLARE_ENV?.trim()
  if (!envName) return 'CLOUDFLARE_ENV unset — environment check skipped'
  const url = env.TURBOPANEL_DATABASE_URL?.trim() || env.DATABASE_URL?.trim()
  const target = url ? migrateTargetFromUrl(url) : null
  if (!target) throw new Error(`CLOUDFLARE_ENV=${envName} needs a TCP TURBOPANEL_DATABASE_URL to check against the Hyperdrive origin`)
  const { id, accountId } = readHyperdriveIdForEnv(envName)
  const origin = (await readOriginFromApi(accountId, id)) ?? readOriginFromWrangler(id)
  if (!origin?.host || !origin?.database || !origin?.user) {
    throw new Error(`Hyperdrive ${id} (env ${envName}) has no readable origin — refusing to migrate blind`)
  }
  const mismatches = compareTarget(target, origin)
  if (mismatches.length > 0) {
    throw new Error(
      `TURBOPANEL_DATABASE_URL is not env ${envName}'s Hyperdrive origin (${mismatches.join('; ')}) — refusing`,
    )
  }
  return `TURBOPANEL_DATABASE_URL matches env ${envName}'s Hyperdrive origin (${origin.host}/${origin.database}; migrate as ${target.user})`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertMigrateTargetMatchesEnv().then(
    (line) => console.log(`check-deploy-env: ${line}`),
    (err) => {
      console.error(`check-deploy-env: ${err.message}`)
      process.exit(1)
    },
  )
}
