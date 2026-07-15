#!/usr/bin/env node
/**
 * Ensure env.testing has a dedicated cached Hyperdrive config (testing-cached).
 * Prints the config id on stdout. With --write-wrangler, patches wrangler.jsonc.
 *
 * Auth: CLOUDFLARE_API_TOKEN required to *create* a missing config; list/get may
 * use the token or `wrangler login` OAuth.
 *
 * Subprocess args for list/get are typed-allowlisted and passed via execFileSync
 * (no shell). Hyperdrive create is Cloudflare API only — never origin fields on argv.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const wranglerJsoncPath = join(repoRoot, 'wrangler.jsonc')
const vendoredNodeBin = '/opt/turbopanel/vendor/node/current/bin/node'
const wranglerJsPath = join(repoRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/
/** Cloudflare Hyperdrive config display name (env override). */
const CONFIG_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** Single DNS label (RFC-ish length; no leading/trailing hyphen). */
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/
/** Postgres role / database identifiers (no shell metacharacters). */
const PG_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/

const PLACEHOLDER_ID = '0000000000000000000000000000dev0'

function validatePattern(value, pattern, label) {
  if (typeof value !== 'string' || value.length === 0 || !pattern.test(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function validateHyperdriveId(id, label) {
  return validatePattern(id, HYPERDRIVE_ID_RE, `Hyperdrive id (${label})`)
}

function validateAccountId(id) {
  return validatePattern(id, ACCOUNT_ID_RE, 'Cloudflare account id')
}

function validateConfigName(name) {
  return validatePattern(name, CONFIG_NAME_RE, 'Hyperdrive config name')
}

/** Hostname or IPv4 literal from the primary Hyperdrive origin. */
function isOriginHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    return false
  }
  const ipv4Parts = host.split('.')
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d{1,3}$/.test(part))) {
    return ipv4Parts.every((part) => {
      const n = Number(part)
      return n >= 0 && n <= 255
    })
  }
  const labels = host.split('.')
  if (labels.length === 1) {
    return DNS_LABEL_RE.test(labels[0])
  }
  const tld = labels.at(-1)
  if (!tld || tld.length < 2 || tld.length > 63 || !/^[A-Za-z]+$/.test(tld)) {
    return false
  }
  return labels.slice(0, -1).every((label) => DNS_LABEL_RE.test(label))
}

function validateOriginHost(host) {
  if (!isOriginHost(host)) {
    throw new Error('Invalid origin host')
  }
  return host
}

function validateOriginPort(port) {
  const raw = String(port)
  if (!/^\d{1,5}$/.test(raw)) {
    throw new Error('Invalid origin port')
  }
  const n = Number(raw)
  if (n < 1 || n > 65535) {
    throw new Error('Invalid origin port')
  }
  return raw
}

function validatePgIdent(value, label) {
  return validatePattern(value, PG_IDENT_RE, label)
}

const ACCOUNT_ID = validateAccountId(
  process.env.CLOUDFLARE_ACCOUNT_ID ?? 'a574c2793baa3e2276ac16e96097bc8c',
)
const CONFIG_NAME = validateConfigName(
  process.env.TURBOPANEL_TESTING_HYPERDRIVE_CACHED_NAME ?? 'testing-cached',
)
const PRIMARY_ID = validateHyperdriveId(
  process.env.TURBOPANEL_TESTING_HYPERDRIVE_PRIMARY_ID ?? '83edd62a2d7e4e6ba8b5d77b01ca3729',
  'primary',
)

const writeWrangler = process.argv.includes('--write-wrangler')

function resolveNodeBin() {
  try {
    execFileSync(vendoredNodeBin, ['--version'], { stdio: 'ignore' })
    return vendoredNodeBin
  } catch {
    return process.execPath
  }
}

function wranglerHyperdriveList() {
  try {
    return execFileSync(resolveNodeBin(), [wranglerJsPath, 'hyperdrive', 'list'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    }).trim()
  } catch {
    throw new Error('wrangler failed')
  }
}

function wranglerHyperdriveGet(id) {
  const safeId = validateHyperdriveId(id, 'get')
  try {
    return execFileSync(resolveNodeBin(), [wranglerJsPath, 'hyperdrive', 'get', safeId], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    }).trim()
  } catch {
    throw new Error('wrangler failed')
  }
}

async function cfFetch(path, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim()
  if (!token) return null
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const body = await response.json()
  if (!response.ok || !body.success) {
    const message = body.errors?.[0]?.message ?? response.statusText
    throw new Error(`Cloudflare API request failed: ${message}`)
  }
  return body.result
}

function parseWranglerListOutput(text) {
  const configs = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length < 2) continue
    const id = parts[0].trim()
    if (!HYPERDRIVE_ID_RE.test(id)) continue
    configs.push({ id, name: parts[1].trim() })
  }
  return configs
}

async function listConfigs() {
  const apiResult = await cfFetch(
    `/accounts/${ACCOUNT_ID}/hyperdrive/configs?per_page=100`,
  ).catch(() => null)
  if (Array.isArray(apiResult)) {
    return apiResult.map((row) => ({ id: row.id, name: row.name }))
  }
  return parseWranglerListOutput(wranglerHyperdriveList())
}

async function getConfig(id) {
  const safeId = validateHyperdriveId(id, 'get')
  const apiResult = await cfFetch(
    `/accounts/${ACCOUNT_ID}/hyperdrive/configs/${safeId}`,
  ).catch(() => null)
  if (apiResult) return apiResult
  const output = wranglerHyperdriveGet(safeId)
  const match = /"id"\s*:\s*"([0-9a-f]{32})"/.exec(output)
  if (!match) {
    throw new Error('Could not parse hyperdrive get output')
  }
  return { id: match[1], raw: output }
}

async function createCachedConfig(primary) {
  const origin = primary.origin
  if (!origin?.host || !origin?.database || !origin?.user) {
    throw new Error(
      `Primary Hyperdrive is missing origin fields; create ${CONFIG_NAME} manually with wrangler hyperdrive create`,
    )
  }

  const host = validateOriginHost(origin.host)
  const port = validateOriginPort(origin.port ?? 5432)
  const user = validatePgIdent(origin.user, 'origin user')
  const database = validatePgIdent(origin.database, 'database')

  const apiPayload = {
    name: CONFIG_NAME,
    origin: {
      database,
      host,
      port: Number(port),
      scheme: origin.scheme ?? 'postgresql',
      user,
      password: origin.password,
    },
    caching: { disabled: false },
  }

  // Create only via Cloudflare API — never pass origin host/user/database on
  // wrangler argv (jssecurity:S6350 argument injection; passwords off argv too).
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
    throw new Error(
      `Set CLOUDFLARE_API_TOKEN to create ${CONFIG_NAME}; create is API-only`,
    )
  }
  const apiResult = await cfFetch(
    `/accounts/${ACCOUNT_ID}/hyperdrive/configs`,
    { method: 'POST', body: JSON.stringify(apiPayload) },
  )
  if (!apiResult?.id) {
    throw new Error(`Cloudflare API did not return an id for ${CONFIG_NAME}`)
  }
  return validateHyperdriveId(apiResult.id, 'create-api')
}

function patchWranglerJsonc(id) {
  const safeId = validateHyperdriveId(id, 'patch')
  const text = readFileSync(wranglerJsoncPath, 'utf8')
  const missing = 'Could not locate env.testing HYPERDRIVE_CACHED binding in wrangler.jsonc'
  const testingAt = text.indexOf('"testing"')
  if (testingAt < 0) {
    throw new Error(missing)
  }
  const marker = '"binding": "HYPERDRIVE_CACHED"'
  const bindingAt = text.indexOf(marker, testingAt)
  if (bindingAt < 0) {
    throw new Error(missing)
  }
  // Stay inside env.testing — do not patch a later env (e.g. live).
  const liveAt = text.indexOf('"live"', testingAt)
  if (liveAt >= 0 && bindingAt > liveAt) {
    throw new Error(missing)
  }
  const idKeyAt = text.indexOf('"id"', bindingAt)
  if (idKeyAt < 0 || (liveAt >= 0 && idKeyAt > liveAt)) {
    throw new Error(missing)
  }
  const colonAt = text.indexOf(':', idKeyAt)
  const openQuote = colonAt < 0 ? -1 : text.indexOf('"', colonAt + 1)
  const closeQuote = openQuote < 0 ? -1 : text.indexOf('"', openQuote + 1)
  if (openQuote < 0 || closeQuote < 0) {
    throw new Error(missing)
  }
  const next = `${text.slice(0, openQuote + 1)}${safeId}${text.slice(closeQuote)}`
  writeFileSync(wranglerJsoncPath, next)
}

/** Emit a validated Hyperdrive id on stdout (script contract — not diagnostic logging). */
function emitConfigId(id) {
  process.stdout.write(`${validateHyperdriveId(id, 'emit')}\n`)
}

async function main() {
  const preset = process.env.TURBOPANEL_TESTING_HYPERDRIVE_CACHED_ID?.trim()
  if (preset && preset !== PLACEHOLDER_ID) {
    if (writeWrangler) patchWranglerJsonc(preset)
    emitConfigId(preset)
    return
  }

  const configs = await listConfigs()
  const existing = configs.find((row) => row.name === CONFIG_NAME)
  if (existing?.id && existing.id !== PLACEHOLDER_ID) {
    if (writeWrangler) patchWranglerJsonc(existing.id)
    emitConfigId(existing.id)
    return
  }

  const primary = await getConfig(PRIMARY_ID)
  const createdId = await createCachedConfig(primary)
  if (writeWrangler) patchWranglerJsonc(createdId)
  emitConfigId(createdId)
}

try {
  await main()
} catch {
  console.error('ensure-testing-hyperdrive-cached failed')
  process.exit(1)
}
