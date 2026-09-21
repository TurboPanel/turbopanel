#!/usr/bin/env node
/**
 * Cross-repo contract drift check.
 *
 * Compares the isolated `src/contracts/` twins against the sibling checkout
 * (`../turbopaneld` when run from turbopanel, `../turbopanel` when run from
 * turbopaneld). Missing sibling → skip (exit 0), matching
 * `check-metrics-legacy.ts`. Dual-checkout CI that already clones both
 * (turbopanel `metrics-legacy` job) must run this.
 *
 * Pairs:
 *   - metrics contract body (byte-equal below the header docblock)
 *   - hostname regex
 *   - machine-key namespace UUID
 *   - UPDATE_CHANNELS vocabulary
 *   - ServerReportedIp field set
 *   - slot-mapping constants (MAX_NIC_SLOTS + FILESYSTEM_ROLE_PRIORITY)
 *
 * Command schemas stay comment-pinned until they are twins.
 *
 * Usage:
 *   node scripts/check-contract-drift.mjs
 *   pnpm check:contract-drift
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')

function stripHeaderDocblock(source) {
  const end = source.indexOf('*/')
  return end === -1 ? source : source.slice(end + 2)
}

function isWordChar(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') || ch === '_'
}

function isWord(value) {
  if (!value) return false
  for (const ch of value) {
    if (!isWordChar(ch)) return false
  }
  return true
}

function normalizeWs(value) {
  let out = ''
  let inSpace = false
  for (const ch of value.trim()) {
    const space = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
    if (space) {
      inSpace = true
      continue
    }
    if (inSpace && out.length > 0) out += ' '
    inSpace = false
    out += ch
  }
  return out
}

function quotedStrings(source) {
  const out = []
  let i = 0
  while (i < source.length) {
    const quote = source[i]
    if (quote !== "'" && quote !== '"') {
      i += 1
      continue
    }
    const end = source.indexOf(quote, i + 1)
    if (end === -1) break
    const token = source.slice(i + 1, end)
    if (token.length > 0) out.push(token)
    i = end + 1
  }
  return out.sort((a, b) => a.localeCompare(b))
}

function stripQuotes(value) {
  return value.replaceAll("'", '').replaceAll('"', '')
}

function extractAfterEquals(source, marker) {
  const start = source.indexOf(marker)
  if (start === -1) return null
  const eq = source.indexOf('=', start + marker.length)
  if (eq === -1) return null
  return eq + 1
}

function extractConst(source, name) {
  const from = extractAfterEquals(source, `export const ${name}`)
  if (from == null) return null
  let end = from
  while (end < source.length && source[end] !== '\n' && source[end] !== ';') {
    end += 1
  }
  const captured = source.slice(from, end).trim()
  if (!captured) return null
  return stripQuotes(normalizeWs(captured))
}

function extractTypeFields(source, typeName) {
  const from = extractAfterEquals(source, `export type ${typeName}`)
  if (from == null) return null
  const open = source.indexOf('{', from)
  const close = source.indexOf('}', open)
  if (open === -1 || close === -1) return null
  const names = []
  for (const line of source.slice(open + 1, close).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon < 1) continue
    let name = trimmed.slice(0, colon)
    if (name.endsWith('?')) name = name.slice(0, -1)
    if (isWord(name)) names.push(name)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

function extractArrayConst(source, name) {
  const idx = source.indexOf(`const ${name}`)
  if (idx === -1) return null
  const open = source.indexOf('[', idx)
  const close = source.indexOf(']', open)
  if (open === -1 || close === -1) return null
  return quotedStrings(source.slice(open + 1, close))
}

function fail(message) {
  const error = new Error(`check-contract-drift: ${message}`)
  console.error(error.message)
  throw error
}

function resolveLayout() {
  const pkgPath = path.join(ROOT, 'package.json')
  const pkg = fs.existsSync(pkgPath)
    ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    : {}
  if (pkg.name === 'turbopanel') {
    return {
      self: ROOT,
      sibling: path.resolve(ROOT, '../turbopaneld'),
      selfName: 'turbopanel',
    }
  }
  return {
    self: ROOT,
    sibling: path.resolve(ROOT, '../turbopanel'),
    selfName: 'turbopaneld',
  }
}

function readRel(root, rel) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) return null
  return fs.readFileSync(abs, 'utf8')
}

function requireText(value, message) {
  if (value == null) fail(message)
  return value
}

function requireEqual(left, right, message) {
  if (left !== right || left == null) fail(message)
}

function requireJoinedEqual(left, right, message) {
  if (left?.join(',') !== right?.join(',') || right == null) fail(message)
}

function checkMetrics(tp, td) {
  const metricsLeft = requireText(
    readRel(tp, 'src/contracts/metrics-contract.ts'),
    'metrics-contract.ts missing on one side of the pair',
  )
  const metricsRight = requireText(
    readRel(td, 'src/contracts/metrics-contract.ts'),
    'metrics-contract.ts missing on one side of the pair',
  )
  if (stripHeaderDocblock(metricsLeft) !== stripHeaderDocblock(metricsRight)) {
    fail('metrics-contract.ts body drifted (below the header docblock)')
  }
}

function checkHostname(tp, td) {
  const hostnameLeft = requireText(
    readRel(tp, 'src/contracts/commands/hostname.ts'),
    'hostname sources missing on one side of the pair',
  )
  const hostnameRight = requireText(
    readRel(td, 'src/contracts/commands-contracts.ts'),
    'hostname sources missing on one side of the pair',
  )
  requireEqual(
    extractConst(hostnameLeft, 'HOSTNAME_RE'),
    extractConst(hostnameRight, 'HOSTNAME_RE'),
    'HOSTNAME_RE drifted',
  )
  requireEqual(
    extractConst(hostnameLeft, 'HOSTNAME_MAX_LENGTH'),
    extractConst(hostnameRight, 'HOSTNAME_MAX_LENGTH'),
    'HOSTNAME_MAX_LENGTH drifted',
  )
}

function checkMachineKey(tp, td) {
  const mkLeft = requireText(
    readRel(tp, 'src/lib/machine-key.ts'),
    'machine-key.ts missing on one side of the pair',
  )
  const mkRight = requireText(
    readRel(td, 'src/host/machine-key.ts'),
    'machine-key.ts missing on one side of the pair',
  )
  requireEqual(
    extractConst(mkLeft, 'TURBOPANEL_MACHINE_ID_NAMESPACE'),
    extractConst(mkRight, 'TURBOPANEL_MACHINE_ID_NAMESPACE'),
    'TURBOPANEL_MACHINE_ID_NAMESPACE drifted',
  )
}

function checkUpdateChannels(tp, td) {
  const channelsLeftSrc = requireText(
    readRel(tp, 'src/contracts/update-channel.ts'),
    'update-channel sources missing on one side of the pair',
  )
  const channelsRightSrc = requireText(
    readRel(td, 'src/update/types.ts'),
    'update-channel sources missing on one side of the pair',
  )
  const channelsLeft = extractArrayConst(channelsLeftSrc, 'UPDATE_CHANNELS')
  const marker = 'export type UpdateChannel'
  const start = channelsRightSrc.indexOf(marker)
  let channelsRight = null
  if (start !== -1) {
    const from = channelsRightSrc.indexOf('=', start)
    const to = channelsRightSrc.indexOf(';', from)
    if (from !== -1 && to !== -1) {
      channelsRight = quotedStrings(channelsRightSrc.slice(from + 1, to))
    }
  }
  requireJoinedEqual(
    channelsLeft,
    channelsRight,
    `UPDATE_CHANNELS drifted (${channelsLeft?.join(',')} vs ${channelsRight?.join(',')})`,
  )
}

function checkReportedIp(tp, td) {
  const ipLeftSrc = requireText(
    readRel(tp, 'src/contracts/server-addresses.ts'),
    'ServerReportedIp sources missing on one side of the pair',
  )
  const ipRightSrc = requireText(
    readRel(td, 'src/contracts/server-reported-ip.ts'),
    'ServerReportedIp sources missing on one side of the pair',
  )
  requireJoinedEqual(
    extractTypeFields(ipLeftSrc, 'ServerReportedIp'),
    extractTypeFields(ipRightSrc, 'ServerReportedIp'),
    'ServerReportedIp fields drifted',
  )
}

function checkSlotMapping(tp, td) {
  const slotLeftTypes = requireText(
    readRel(tp, 'src/contracts/topology-types.ts'),
    'topology slot-mapping sources missing on one side of the pair',
  )
  const slotRightTypes = requireText(
    readRel(td, 'src/contracts/topology-types.ts'),
    'topology slot-mapping sources missing on one side of the pair',
  )
  const slotLeftMap = requireText(
    readRel(tp, 'src/contracts/topology-slot-mapping.ts'),
    'topology slot-mapping sources missing on one side of the pair',
  )
  const slotRightMap = requireText(
    readRel(td, 'src/contracts/topology-slot-mapping.ts'),
    'topology slot-mapping sources missing on one side of the pair',
  )
  requireEqual(
    extractConst(slotLeftTypes, 'MAX_NIC_SLOTS'),
    extractConst(slotRightTypes, 'MAX_NIC_SLOTS'),
    'MAX_NIC_SLOTS drifted',
  )
  requireJoinedEqual(
    extractArrayConst(slotLeftMap, 'FILESYSTEM_ROLE_PRIORITY'),
    extractArrayConst(slotRightMap, 'FILESYSTEM_ROLE_PRIORITY'),
    'FILESYSTEM_ROLE_PRIORITY drifted',
  )
}

function main() {
  const { self, sibling, selfName } = resolveLayout()
  if (!fs.existsSync(path.join(sibling, 'src'))) {
    console.log(
      `check-contract-drift: sibling checkout missing at ${sibling}; skip`,
    )
    return
  }

  const tp = selfName === 'turbopanel' ? self : sibling
  const td = selfName === 'turbopaneld' ? self : sibling
  checkMetrics(tp, td)
  checkHostname(tp, td)
  checkMachineKey(tp, td)
  checkUpdateChannels(tp, td)
  checkReportedIp(tp, td)
  checkSlotMapping(tp, td)

  console.log('check-contract-drift: metrics, hostname, machine-key, channels, ServerReportedIp, slot-mapping agree.')
}

try {
  main()
} catch (error) {
  if (error instanceof Error && error.message.startsWith('check-contract-drift:')) {
    process.exit(1)
  }
  throw error
}
