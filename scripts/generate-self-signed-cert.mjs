#!/usr/bin/env node
/**
 * Generate the TurboPanel platform TLS certificate chain (self-hosted).
 *
 * Produces:
 *   certs/ca.crt + certs/ca.key     — platform CA (distribute to agent nodes / browsers)
 *   certs/self-signed.crt + .key    — server leaf cert presented by Caddy
 *
 * Regenerates the server cert when interface addresses or DNS names change.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

function loadEnvFile() {
  const envPath =
    process.env.TURBOPANEL_INSTANCE_RUNTIME_ENV?.trim() ||
    '/opt/turbopanel/platform/config/instance/runtime.env'
  if (!existsSync(envPath)) return

  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    const existing = process.env[key]
    if (existing === undefined || existing.trim() === '') {
      process.env[key] = value
    }
  }
}

loadEnvFile()
const certsDir = path.join(repoRoot, 'certs')
const caCrtPath = path.join(certsDir, 'ca.crt')
const caKeyPath = path.join(certsDir, 'ca.key')
const caSrlPath = path.join(certsDir, 'ca.srl')
const crtPath = path.join(certsDir, 'self-signed.crt')
const keyPath = path.join(certsDir, 'self-signed.key')
const csrPath = path.join(certsDir, 'server.csr')
const extPath = path.join(certsDir, 'server-ext.cnf')
const certCommonName = 'TurboPanel Instance'
const caCommonName = 'TurboPanel Platform CA'
const days = '3650'

function normalizeIp(ip) {
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return '0:0:0:0:0:0:0:1'
  return lower
}

function normalizeSan(entry) {
  if (entry.startsWith('DNS:')) return entry
  return `IP:${normalizeIp(entry.slice(3))}`
}

// Env vars whose URL host(s) should be covered by the server cert. These are
// the address(es) daemons actually dial, so the leaf cert must be valid for
// them. Keeping this as the single source of truth means any hostname works
// without hardcoding — set the URL(s) and the SAN follows.
//
// A control plane can be reachable at MULTIPLE addresses at once (e.g. an
// internal LAN host AND an external/tunnel hostname), so every var is treated
// as a comma-separated list. `TURBOPANEL_PUBLIC_URLS` (plural) is the canonical
// operator-managed list; the singular vars are accepted for convenience.
const PUBLIC_URL_ENV_KEYS = [
  'TURBOPANEL_PUBLIC_URLS',
  'TURBOPANEL_PUBLIC_URL',
  'TURBOPANEL_BASE_URL',
  'TURBOPANEL_INSTANCE_URL',
]

function isIpLiteral(host) {
  if (!host) return false
  if (host.includes(':')) return true // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) // IPv4
}

/** Parse one URL or bare host into a normalized hostname, or null to skip. */
function hostFromEntry(entry) {
  const trimmed = entry.trim()
  if (!trimmed) return null
  let host
  try {
    // Accept full URLs ("https://host:port") and bare hosts ("host" / "host:port").
    host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return null
  }
  // URL() wraps IPv6 literals in brackets; strip them for SAN emission.
  host = host.replace(/^\[/, '').replace(/\]$/, '')
  if (!host || host === 'localhost') return null
  return host
}

/** Hostnames/IPs parsed from the configured public/instance URL list(s). */
function urlDerivedHosts() {
  const dns = new Set()
  const ip = new Set()
  for (const key of PUBLIC_URL_ENV_KEYS) {
    const raw = process.env[key]
    if (!raw) continue
    for (const entry of raw.split(',')) {
      const host = hostFromEntry(entry)
      if (!host) continue
      if (isIpLiteral(host)) ip.add(host)
      else dns.add(host)
    }
  }
  return { dns, ip }
}

function explicitDnsNames() {
  const names = new Set()
  for (const entry of process.env.TURBOPANEL_TLS_EXTRA_SANS?.split(',') ?? []) {
    const trimmed = entry.trim()
    if (trimmed) names.add(trimmed)
  }
  for (const name of urlDerivedHosts().dns) names.add(name)
  return names
}

function isUsableDnsName(name, explicit) {
  if (!name || name === 'localhost') return false
  if (explicit.has(name)) return true
  return name.includes('.')
}

function extraDnsSans() {
  const sans = new Set()
  const explicit = explicitDnsNames()
  for (const name of explicit) sans.add(`DNS:${name}`)

  for (const args of [['-f'], ['-s']]) {
    try {
      const name = execFileSync('hostname', args, { encoding: 'utf8' }).trim()
      if (isUsableDnsName(name, explicit)) sans.add(`DNS:${name}`)
    } catch {
      // hostname flags vary by platform
    }
  }

  return sans
}

function subjectAltNames() {
  const sans = new Set(['DNS:localhost', 'IP:127.0.0.1', 'IP:0:0:0:0:0:0:0:1'])
  for (const entry of extraDnsSans()) sans.add(entry)
  for (const addr of urlDerivedHosts().ip) sans.add(normalizeSan(`IP:${addr}`))

  for (const entries of Object.values(networkInterfaces())) {
    for (const ni of entries ?? []) {
      if (ni.internal) continue
      if (ni.family === 'IPv4') {
        sans.add(`IP:${ni.address}`)
      } else if (ni.family === 'IPv6' && !ni.address.startsWith('fe80:')) {
        sans.add(normalizeSan(`IP:${ni.address}`))
      }
    }
  }

  return [...sans].map(normalizeSan).sort()
}

function serverCertMarkedAsCa() {
  if (!existsSync(crtPath)) return false

  try {
    const out = execFileSync(
      'openssl',
      ['x509', '-in', crtPath, '-noout', '-ext', 'basicConstraints'],
      { encoding: 'utf8' },
    )
    return /CA:\s*TRUE/i.test(out)
  } catch {
    return true
  }
}

function readCertSubjectAltNames() {
  if (!existsSync(crtPath)) return []

  try {
    const out = execFileSync(
      'openssl',
      ['x509', '-in', crtPath, '-noout', '-ext', 'subjectAltName'],
      { encoding: 'utf8' },
    )
    const sans = new Set()
    for (const match of out.matchAll(/(?:DNS|IP Address):([^,\n]+)/g)) {
      const value = match[1].trim()
      if (match[0].startsWith('DNS:')) {
        sans.add(`DNS:${value}`)
      } else {
        sans.add(normalizeSan(`IP:${value}`))
      }
    }
    return [...sans].sort()
  } catch {
    return []
  }
}

function removeServerLeafCert() {
  for (const file of [crtPath, keyPath]) {
    if (existsSync(file)) unlinkSync(file)
  }
}

function removeTempServerFiles() {
  for (const file of [csrPath, extPath]) {
    if (existsSync(file)) unlinkSync(file)
  }
}

/** Caddy reads keys as turbopaneli:turbopanel — group must be able to read. */
function normalizeTlsKeyPermissions() {
  for (const file of [caKeyPath, keyPath]) {
    if (existsSync(file)) chmodSync(file, 0o640)
  }
}

function ensureCa() {
  if (existsSync(caCrtPath) && existsSync(caKeyPath)) return

  console.log('generate-self-signed-cert: creating platform CA')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', caKeyPath,
      '-out', caCrtPath,
      '-days', days,
      '-subj', `/O=TurboPanel/CN=${caCommonName}`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
  normalizeTlsKeyPermissions()
}

function generateServerCert(expectedSans) {
  const subject = `/O=TurboPanel/CN=${certCommonName}`
  const sans = `subjectAltName=${expectedSans.join(',')}`

  console.log(
    `generate-self-signed-cert: signing server cert (10y, ${expectedSans.join(', ')})`,
  )

  execFileSync(
    'openssl',
    [
      'req',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', keyPath,
      '-out', csrPath,
      '-subj', subject,
      '-addext', sans,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )

  writeFileSync(
    extPath,
    [
      '[server]',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n'),
  )

  const signArgs = [
    'x509',
    '-req',
    '-in', csrPath,
    '-CA', caCrtPath,
    '-CAkey', caKeyPath,
    '-out', crtPath,
    '-days', days,
    '-copy_extensions', 'copy',
    '-extfile', extPath,
    '-extensions', 'server',
  ]
  if (existsSync(caSrlPath)) {
    signArgs.push('-CAserial', caSrlPath)
  } else {
    signArgs.push('-CAcreateserial')
  }

  execFileSync('openssl', signArgs, { stdio: ['ignore', 'inherit', 'inherit'] })

  removeTempServerFiles()
  normalizeTlsKeyPermissions()
  console.log(`generate-self-signed-cert: wrote ${crtPath}, ${keyPath}, and ${caCrtPath}`)
}

const expectedSans = subjectAltNames()
const existingSans = readCertSubjectAltNames()
const caReady = existsSync(caCrtPath) && existsSync(caKeyPath)

if (
  caReady &&
  existsSync(crtPath) &&
  existsSync(keyPath) &&
  expectedSans.join(',') === existingSans.join(',') &&
  !serverCertMarkedAsCa()
) {
  normalizeTlsKeyPermissions()
  console.log(`generate-self-signed-cert: certificate already up to date at ${certsDir}`)
  process.exit(0)
}

mkdirSync(certsDir, { recursive: true })

if (existsSync(crtPath) || existsSync(keyPath)) {
  const reason = serverCertMarkedAsCa()
    ? 'server certificate was marked as a CA'
    : !caReady
    ? 'local CA is missing'
    : 'interface addresses or DNS names changed'
  console.log(`generate-self-signed-cert: ${reason}; regenerating server certificate`)
  removeServerLeafCert()
}

try {
  ensureCa()
  generateServerCert(expectedSans)
} catch (err) {
  console.error(`generate-self-signed-cert: failed to generate certificate: ${err.message}`)
  console.error('generate-self-signed-cert: ensure openssl is installed and on PATH')
  process.exit(1)
}
