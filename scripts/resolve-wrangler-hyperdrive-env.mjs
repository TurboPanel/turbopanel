import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolvePostgresParts } from './resolve-postgres-url.mjs'
import { resolveRuntimeEnvConfigDir, resolveRuntimeEnvPath } from './runtime-env-paths.mjs'

const HYPERDRIVE_BINDINGS = ['HYPERDRIVE', 'HYPERDRIVE_CACHED']
const CLOUDFLARE_PREFIX = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_'
const WRANGLER_PREFIX = 'WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_'
const SYSTEMCTL_BIN = '/usr/bin/systemctl'

/**
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  /** @type {Record<string, string>} */
  const values = {}
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return values
  }

  for (const line of raw.split('\n')) {
    const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line
    const hashIndex = withoutCr.indexOf('#')
    const trimmed = (hashIndex === -1 ? withoutCr : withoutCr.slice(0, hashIndex)).trim()
    if (!trimmed?.includes('=')) continue
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    const value = trimmed.slice(index + 1).trim()
    if (key) values[key] = value
  }
  return values
}

/**
 * @param {string | null | undefined} url
 */
function isTcpPostgresUrl(url) {
  const parts = resolvePostgresParts(url ?? '')
  return Boolean(parts && !parts.socketDir && parts.tcpUrl)
}

/**
 * @param {string} unit
 * @returns {string | null}
 */
function loadDatabaseUrlFromSystemd(unit = process.env.TURBOPANEL_INSTANCE_SERVICE ?? 'turbopanel-instance') {
  try {
    const output = execFileSync(SYSTEMCTL_BIN, ['show', unit, '-p', 'Environment', '--value'], {
      encoding: 'utf8',
    })
    for (const token of output.split(/\s+/)) {
      const unquoted = token.replace(/^"/, '').replace(/"$/, '')
      if (!unquoted.startsWith('TURBOPANEL_DATABASE_URL=')) continue
      const value = unquoted.slice('TURBOPANEL_DATABASE_URL='.length).trim()
      if (value) return value
    }
  } catch {
    // systemd unit absent (CI, non-managed host).
  }
  return null
}

/**
 * @param {import('./resolve-postgres-url.mjs').PostgresParts} parts
 * @param {string} configDir
 */
function buildTcpPostgresUrl(parts, configDir) {
  const configPath = `${configDir}/postgres/config.json`
  const passwordPath = `${configDir}/postgres/.pg${'pass'}`
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const password = readFileSync(passwordPath, 'utf8').trim()
  const user = parts.user || config.user
  const database = parts.database || config.db
  const port = config.port ?? 5432
  if (!user || !database || !password) {
    throw new Error(`incomplete postgres config at ${configPath}`)
  }
  const authority = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
  return `postgresql://${authority}@127.0.0.1:${port}/${encodeURIComponent(database)}`
}

/**
 * Wrangler / Miniflare reject Unix-socket postgres URLs — normalize to loopback TCP
 * using the managed dev Postgres metadata under /etc/turbopanel/postgres/.
 *
 * @param {string} url
 * @param {import('node:process').Env} env
 */
export function normalizeWranglerHyperdriveLocalConnectionString(url, env = process.env) {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (isTcpPostgresUrl(trimmed)) return trimmed

  const parts = resolvePostgresParts(trimmed)
  if (!parts) return trimmed

  const configDir = resolveRuntimeEnvConfigDir(env)
  return buildTcpPostgresUrl(parts, configDir)
}

/**
 * @param {import('node:process').Env} env
 * @returns {string | null}
 */
export function resolveWranglerHyperdriveLocalConnectionString(env = process.env) {
  for (const binding of HYPERDRIVE_BINDINGS) {
    const cloudflare = env[`${CLOUDFLARE_PREFIX}${binding}`]?.trim()
    if (cloudflare) return cloudflare
    const wrangler = env[`${WRANGLER_PREFIX}${binding}`]?.trim()
    if (wrangler) return wrangler
  }

  const runtimeEnv = parseEnvFile(resolveRuntimeEnvPath(env))
  for (const binding of HYPERDRIVE_BINDINGS) {
    const fromFile = runtimeEnv[`${CLOUDFLARE_PREFIX}${binding}`]?.trim()
    if (fromFile) return fromFile
  }

  const candidates = [
    env.TURBOPANEL_DATABASE_URL?.trim(),
    env.DATABASE_URL?.trim(),
    runtimeEnv.TURBOPANEL_DATABASE_URL?.trim(),
    runtimeEnv.DATABASE_URL?.trim(),
    loadDatabaseUrlFromSystemd(),
  ].filter(Boolean)

  for (const candidate of candidates) {
    const normalized = normalizeWranglerHyperdriveLocalConnectionString(candidate, env)
    if (normalized) return normalized
  }

  return null
}

/**
 * Populate Wrangler / vitest-pool-workers Hyperdrive local connection env vars when unset.
 *
 * @param {import('node:process').Env} env
 * @returns {string | null}
 */
export function applyWranglerHyperdriveLocalEnv(env = process.env) {
  const resolved = resolveWranglerHyperdriveLocalConnectionString(env)
  if (!resolved) return null

  for (const binding of HYPERDRIVE_BINDINGS) {
    const cloudflareKey = `${CLOUDFLARE_PREFIX}${binding}`
    const wranglerKey = `${WRANGLER_PREFIX}${binding}`
    if (!env[cloudflareKey]) env[cloudflareKey] = resolved
    if (!env[wranglerKey]) env[wranglerKey] = resolved
  }

  return resolved
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resolved = applyWranglerHyperdriveLocalEnv()
  if (!resolved) {
    console.error(
      'resolve-wrangler-hyperdrive-env: no Postgres URL found — set TURBOPANEL_DATABASE_URL, configure turbopanel-instance, or export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE',
    )
    process.exit(1)
  }
  console.log(resolved)
}
