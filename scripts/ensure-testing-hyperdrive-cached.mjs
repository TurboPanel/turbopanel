#!/usr/bin/env node
/**
 * Ensure env.testing has a dedicated cached Hyperdrive config (testing-cached).
 * Prints the config id on stdout. With --write-wrangler, patches wrangler.jsonc.
 *
 * Auth: CLOUDFLARE_API_TOKEN (preferred) or `wrangler login` OAuth.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const wranglerJsoncPath = join(repoRoot, 'wrangler.jsonc')

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? 'a574c2793baa3e2276ac16e96097bc8c'
const CONFIG_NAME = process.env.TURBOPANEL_TESTING_HYPERDRIVE_CACHED_NAME ?? 'testing-cached'
const PRIMARY_ID = process.env.TURBOPANEL_TESTING_HYPERDRIVE_PRIMARY_ID ?? '83edd62a2d7e4e6ba8b5d77b01ca3729'
const PLACEHOLDER_ID = '0000000000000000000000000000dev0'

const writeWrangler = process.argv.includes('--write-wrangler')

function resolveNodeBin() {
  const vendored = '/opt/turbopanel/vendor/node/current/bin/node'
  try {
    spawnSync(vendored, ['--version'], { stdio: 'ignore' })
    return vendored
  } catch {
    return process.execPath
  }
}

function runWrangler(args) {
  const nodeBin = resolveNodeBin()
  const wranglerJs = join(repoRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const result = spawnSync(nodeBin, [wranglerJs, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    const suffix = detail ? `: ${detail}` : ''
    throw new Error(`wrangler ${args.join(' ')} failed${suffix}`)
  }
  return (result.stdout || '').trim()
}

async function cfFetch(path, init = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim()
  if (!token) return null
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await response.json()
  if (!response.ok || !body.success) {
    const message = body.errors?.[0]?.message ?? response.statusText
    throw new Error(`Cloudflare API ${path}: ${message}`)
  }
  return body.result
}

function parseWranglerListOutput(text) {
  const configs = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length < 2) continue
    const id = parts[0].trim()
    if (!/^[0-9a-f]{32}$/.test(id)) continue
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
  const output = runWrangler(['hyperdrive', 'list'])
  return parseWranglerListOutput(output)
}

async function getConfig(id) {
  const apiResult = await cfFetch(
    `/accounts/${ACCOUNT_ID}/hyperdrive/configs/${id}`,
  ).catch(() => null)
  if (apiResult) return apiResult
  const output = runWrangler(['hyperdrive', 'get', id])
  const match = /"id"\s*:\s*"([0-9a-f]{32})"/.exec(output)
  if (!match) {
    throw new Error(`Could not parse hyperdrive get output for ${id}`)
  }
  return { id: match[1], raw: output }
}

async function createCachedConfig(primary) {
  const origin = primary.origin
  if (!origin?.host || !origin?.database || !origin?.user) {
    throw new Error(
      `Primary Hyperdrive ${PRIMARY_ID} is missing origin fields; create ${CONFIG_NAME} manually with wrangler hyperdrive create`,
    )
  }

  const apiPayload = {
    name: CONFIG_NAME,
    origin: {
      database: origin.database,
      host: origin.host,
      port: origin.port ?? 5432,
      scheme: origin.scheme ?? 'postgresql',
      user: origin.user,
      password: origin.password,
    },
    caching: { disabled: false },
  }

  const apiResult = await cfFetch(
    `/accounts/${ACCOUNT_ID}/hyperdrive/configs`,
    { method: 'POST', body: JSON.stringify(apiPayload) },
  ).catch(() => null)
  if (apiResult?.id) return apiResult.id

  const args = [
    'hyperdrive',
    'create',
    CONFIG_NAME,
    '--origin-host',
    origin.host,
    '--origin-port',
    String(origin.port ?? 5432),
    '--origin-user',
    origin.user,
    '--database',
    origin.database,
  ]
  if (origin.password) {
    args.push('--origin-password', origin.password)
  }
  const output = runWrangler(args)
  const match = /"id"\s*:\s*"([0-9a-f]{32})"/.exec(output)
  if (!match) {
    throw new Error(`Could not parse hyperdrive create output for ${CONFIG_NAME}`)
  }
  return match[1]
}

function patchWranglerJsonc(id) {
  const text = readFileSync(wranglerJsoncPath, 'utf8')
  const testingBlock = /("testing"\s*:\s*\{[\s\S]*?"hyperdrive"\s*:\s*\[[\s\S]*?"binding"\s*:\s*"HYPERDRIVE_CACHED"\s*,\s*"id"\s*:\s*")[^"]+(")/.exec(text)
  if (!testingBlock) {
    throw new Error('Could not locate env.testing HYPERDRIVE_CACHED binding in wrangler.jsonc')
  }
  const next = text.replace(testingBlock[0], `${testingBlock[1]}${id}${testingBlock[2]}`)
  writeFileSync(wranglerJsoncPath, next)
}

async function main() {
  const preset = process.env.TURBOPANEL_TESTING_HYPERDRIVE_CACHED_ID?.trim()
  if (preset && preset !== PLACEHOLDER_ID) {
    if (writeWrangler) patchWranglerJsonc(preset)
    console.log(preset)
    return
  }

  const configs = await listConfigs()
  const existing = configs.find((row) => row.name === CONFIG_NAME)
  if (existing?.id && existing.id !== PLACEHOLDER_ID) {
    if (writeWrangler) patchWranglerJsonc(existing.id)
    console.log(existing.id)
    return
  }

  const primary = await getConfig(PRIMARY_ID)
  const createdId = await createCachedConfig(primary)
  if (writeWrangler) patchWranglerJsonc(createdId)
  console.log(createdId)
}

try {
  await main()
} catch (err) {
  console.error(String(err.message ?? err))
  process.exit(1)
}
