#!/usr/bin/env node
/**
 * Generate the TurboPanel platform TLS certificate chain (self-hosted).
 *
 * Produces:
 *   <stateDir>/tls/ca.crt + ca.key + ca-bundle.pem  — durable platform CA
 *   certs/self-signed.crt + .key                    — server leaf presented by Caddy
 *
 * The platform CA lives in the state tree (not the replaceable instance checkout).
 * Regenerates the server cert when interface addresses or DNS names change.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRuntimeEnvPath } from './runtime-env-paths.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')

function loadEnvFile() {
  const envPath = resolveRuntimeEnvPath()
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

const DEFAULT_STATE_DIR = '/var/lib/turbopanel'

function envTrim(name) {
  const value = process.env[name]
  return typeof value === 'string' ? value.trim() : ''
}

function resolveStateDir() {
  return envTrim('TURBOPANEL_STATE_DIR') || DEFAULT_STATE_DIR
}

const certsDir = envTrim('TURBOPANEL_TLS_CERTS_DIR') || path.join(repoRoot, 'certs')
const caDir = path.join(resolveStateDir(), 'tls')
const caCrtPath = envTrim('TURBOPANEL_TLS_CA') || path.join(caDir, 'ca.crt')
const caKeyPath = envTrim('TURBOPANEL_TLS_CA_KEY') || path.join(caDir, 'ca.key')
const caBundlePath = envTrim('TURBOPANEL_TLS_CA_BUNDLE') || path.join(caDir, 'ca-bundle.pem')
const caRetiredPath = path.join(path.dirname(caCrtPath), 'ca-retired.pem')
const caSrlPath = path.join(path.dirname(caCrtPath), 'ca.srl')
const crtPath = path.join(certsDir, 'self-signed.crt')
const keyPath = path.join(certsDir, 'self-signed.key')
const certCommonName = 'TurboPanel Instance'
const caCommonName = 'TurboPanel Platform CA'
const days = '3650'

// --- Safe writes -----------------------------------------------------------
//
// Root runs this script on a managed install while the certs folder belongs to
// the instance account, so anyone who can write that folder can plant a link
// where a file is about to be written. openssl `-out`/`-keyout` and chmod all
// follow links. So nothing here lets openssl or chmod touch a path in a folder
// somebody else can write: openssl works inside a private folder (mode 0700)
// made next to the platform CA, and the result is placed with an exclusive,
// no-follow create of a hidden temp name followed by an atomic rename. A rename
// replaces a link at the target; it never follows it. Modes are set on the
// open descriptor.

const KEY_MODE = 0o640
let workDirPath = ''

function fail(message) {
  cleanupWorkDir()
  console.error(`generate-self-signed-cert: ${message}`)
  process.exit(1)
}

function lstatOrNull(filePath) {
  try {
    return lstatSync(filePath)
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

/** Refuse a folder that is a link or not a folder (certs folder, owner varies). */
function assertPlainDirectory(dir, label) {
  const st = lstatOrNull(dir)
  if (!st) return
  if (st.isSymbolicLink() || !st.isDirectory()) {
    fail(`${label} ${dir} is a link or not a folder; refusing to write through it`)
  }
}

/**
 * A private working folder (0700) inside the platform CA folder, which only
 * root (managed) or the developer (co-located dev) may write.
 */
function getWorkDir() {
  if (workDirPath) return workDirPath
  const base = path.dirname(caCrtPath)
  const before = lstatOrNull(base)
  if (!before || before.isSymbolicLink() || !before.isDirectory()) {
    fail(`platform CA folder ${base} is a link or not a folder; refusing to use it`)
  }
  if ((before.mode & 0o022) !== 0) {
    fail(`platform CA folder ${base} is writable by group or others; refusing to use it`)
  }
  const created = mkdtempSync(path.join(base, '.tls-work-'))
  const mine = lstatSync(created)
  const after = lstatOrNull(base)
  if (
    !mine.isDirectory() ||
    (before.uid !== 0 && before.uid !== mine.uid) ||
    !after ||
    after.ino !== before.ino ||
    after.dev !== before.dev
  ) {
    rmSync(created, { recursive: true, force: true })
    fail(
      `platform CA folder ${base} is not owned as expected or changed underneath; refusing to use it`
    )
  }
  workDirPath = created
  return created
}

function cleanupWorkDir() {
  if (!workDirPath) return
  rmSync(workDirPath, { recursive: true, force: true })
  workDirPath = ''
}

function workFile(name) {
  return path.join(getWorkDir(), name)
}

/**
 * Place `data` at `destPath` atomically. Secret files end at KEY_MODE; other
 * files get the process umask applied to 0666, as an openssl `-out` did.
 * An existing link at the target is replaced, never followed. With
 * `strict`, an existing target that is a link or not a regular file is refused.
 */
function installFile(destPath, data, { secret = false, strict = false } = {}) {
  const existing = lstatOrNull(destPath)
  if (existing && (existing.isDirectory() || (strict && !existing.isFile()))) {
    fail(`${destPath} is a link or not a regular file; refusing to replace it`)
  }
  const dir = path.dirname(destPath)
  assertPlainDirectory(dir, 'target folder')
  const tmp = path.join(dir, `.${path.basename(destPath)}.${randomBytes(8).toString('hex')}.tmp`)
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW
  const fd = openSync(tmp, flags, secret ? 0o600 : 0o666)
  try {
    const buf = Buffer.from(data)
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off)
    if (secret) fchmodSync(fd, KEY_MODE)
    closeSync(fd)
    renameSync(tmp, destPath)
  } catch (err) {
    try {
      closeSync(fd)
    } catch {
      // already closed
    }
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Mode 0640 on an existing key through its descriptor, never through a link. */
function chmodKeyNoFollow(filePath) {
  let fd
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (err) {
    if (err?.code === 'ENOENT') return
    fail(`${filePath} is a link or cannot be opened without following links: ${err?.code ?? err}`)
  }
  try {
    if (!fstatSync(fd).isFile()) fail(`${filePath} is not a regular file`)
    fchmodSync(fd, KEY_MODE)
  } finally {
    closeSync(fd)
  }
}

/**
 * The deprecated leaf names are either files this script wrote or the links the
 * instance-certs role makes to platform-ca.* beside them. Any other link stops
 * the run before anything is read or written through it.
 */
function leafLinkState(filePath, ext) {
  const st = lstatOrNull(filePath)
  if (!st) return 'absent'
  if (st.isSymbolicLink()) {
    if (readlinkSync(filePath) === path.join(certsDir, `platform-ca.${ext}`)) return 'role-link'
    fail(`${filePath} is a link to somewhere else; refusing to read or write through it`)
  }
  if (!st.isFile()) fail(`${filePath} is not a regular file; refusing to use it`)
  return 'file'
}

function assertLeafNamesSafe() {
  assertPlainDirectory(certsDir, 'certs folder')
  leafLinkState(crtPath, 'crt')
  leafLinkState(keyPath, 'key')
}

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
      const name = execFileSync('/usr/bin/hostname', args, {
        encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      }).trim()
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

  return [...sans].map(normalizeSan).sort((a, b) => a.localeCompare(b))
}

function serverCertMarkedAsCa() {
  if (!existsSync(crtPath)) return false

  try {
    const out = execFileSync(
      '/usr/bin/openssl',
      ['x509', '-in', crtPath, '-noout', '-ext', 'basicConstraints'],
      { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } }
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
      '/usr/bin/openssl',
      ['x509', '-in', crtPath, '-noout', '-ext', 'subjectAltName'],
      { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } }
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
    return [...sans].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function removeServerLeafCert() {
  // rmSync removes a link itself (even a dangling one), never what it points at.
  for (const file of [crtPath, keyPath]) rmSync(file, { force: true })
}

/**
 * Caddy reads keys as the instance-stack user — group must be able to read.
 * The leaf key is skipped while it is the role's link to platform-ca.key: that
 * file is the role's to set, and the mode is not changed through a link.
 */
function normalizeTlsKeyPermissions() {
  chmodKeyNoFollow(caKeyPath)
  if (leafLinkState(keyPath, 'key') === 'file') chmodKeyNoFollow(keyPath)
}

// A real open, not accessSync(R_OK): under the compiled instance binary
// (Deno's node compat) accessSync needs --allow-sys=uid to compare owners,
// which the binary deliberately does not grant — it made every existing CA
// look "unreadable" on the second run (install-rehearsal, Road to 0.1.x).
function inspectReadable(filePath) {
  try {
    closeSync(openSync(filePath, 'r'))
    return 'ok'
  } catch (err) {
    if (err?.code === 'ENOENT') return 'absent'
    return 'unreadable'
  }
}

function opensslEnv() {
  return { ...process.env, PATH: '/usr/bin:/bin' }
}

function decodeCertOrThrow(filePath) {
  try {
    execFileSync('/usr/bin/openssl', ['x509', '-in', filePath, '-noout'], {
      stdio: 'pipe',
      env: opensslEnv(),
    })
  } catch {
    console.error(
      `generate-self-signed-cert: existing platform CA at ${filePath} is unreadable or undecodable; refusing to mint a replacement root`
    )
    process.exit(1)
  }
}

function decodeKeyOrThrow(filePath) {
  try {
    execFileSync('/usr/bin/openssl', ['pkey', '-in', filePath, '-noout'], {
      stdio: 'pipe',
      env: opensslEnv(),
    })
  } catch {
    console.error(
      `generate-self-signed-cert: existing platform CA key at ${filePath} is unreadable or undecodable; refusing to mint a replacement root`
    )
    process.exit(1)
  }
}

function isCaRotateRequested() {
  return envTrim('TURBOPANEL_TLS_CA_ROTATE') === '1'
}

function writeCaBundle() {
  const current = readFileSync(caCrtPath, 'utf8').trim()
  let retired = ''
  if (existsSync(caRetiredPath)) {
    retired = readFileSync(caRetiredPath, 'utf8').trim()
  }
  const parts = [current]
  if (retired) parts.push(retired)
  mkdirSync(path.dirname(caBundlePath), { recursive: true, mode: 0o750 })
  installFile(caBundlePath, `${parts.join('\n')}\n`, { strict: true })
}

function mintPlatformCa() {
  mkdirSync(path.dirname(caCrtPath), { recursive: true, mode: 0o750 })
  console.log('generate-self-signed-cert: creating platform CA')
  const workKey = workFile('ca.key')
  const workCrt = workFile('ca.crt')
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      workKey,
      '-out',
      workCrt,
      '-days',
      days,
      '-subj',
      `/O=TurboPanel/CN=${caCommonName}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: opensslEnv(),
    }
  )
  installFile(caKeyPath, readFileSync(workKey), { secret: true, strict: true })
  installFile(caCrtPath, readFileSync(workCrt), { strict: true })
  normalizeTlsKeyPermissions()
}

function rotatePlatformCa() {
  const outgoing = readFileSync(caCrtPath, 'utf8').trim()
  const existingRetired = existsSync(caRetiredPath)
    ? readFileSync(caRetiredPath, 'utf8').trim()
    : ''
  const retiredParts = [outgoing]
  if (existingRetired) retiredParts.push(existingRetired)
  installFile(caRetiredPath, `${retiredParts.join('\n')}\n`, { strict: true })
  mintPlatformCa()
  writeCaBundle()
  console.log(
    'generate-self-signed-cert: rotated platform CA; outgoing root appended to the retired list (bundle rewritten, current first)'
  )
}

function ensureCa() {
  const crtState = inspectReadable(caCrtPath)
  const keyState = inspectReadable(caKeyPath)
  if (crtState === 'unreadable' || keyState === 'unreadable') {
    console.error(
      'generate-self-signed-cert: existing platform CA is present but unreadable; refusing to mint a replacement root'
    )
    process.exit(1)
  }
  if (crtState !== keyState) {
    console.error(
      'generate-self-signed-cert: incomplete platform CA pair (crt vs key); refusing to mint a replacement root'
    )
    process.exit(1)
  }
  if (crtState === 'ok') {
    decodeCertOrThrow(caCrtPath)
    decodeKeyOrThrow(caKeyPath)
    if (isCaRotateRequested()) {
      rotatePlatformCa()
      return
    }
    writeCaBundle()
    return
  }

  mintPlatformCa()
  writeCaBundle()
}

function generateServerCert(expectedSans) {
  const subject = `/O=TurboPanel/CN=${certCommonName}`
  const sans = `subjectAltName=${expectedSans.join(',')}`
  const workKey = workFile('server.key')
  const workCsr = workFile('server.csr')
  const workCrt = workFile('server.crt')
  const workExt = workFile('server-ext.cnf')
  const workSrl = workFile('ca.srl')

  console.log(`generate-self-signed-cert: signing server cert (10y, ${expectedSans.join(', ')})`)

  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      workKey,
      '-out',
      workCsr,
      '-subj',
      subject,
      '-addext',
      sans,
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    }
  )

  writeFileSync(
    workExt,
    [
      '[server]',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      '',
    ].join('\n')
  )

  // The serial file is worked on inside the private folder and placed back
  // afterwards, so openssl never opens it beside the CA.
  const srlExists = existsSync(caSrlPath)
  if (srlExists) writeFileSync(workSrl, readFileSync(caSrlPath))
  const signArgs = [
    'x509',
    '-req',
    '-in',
    workCsr,
    '-CA',
    caCrtPath,
    '-CAkey',
    caKeyPath,
    '-out',
    workCrt,
    '-days',
    days,
    '-copy_extensions',
    'copy',
    '-extfile',
    workExt,
    '-extensions',
    'server',
    '-CAserial',
    workSrl,
  ]
  if (!srlExists) signArgs.push('-CAcreateserial')

  execFileSync('/usr/bin/openssl', signArgs, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  })

  try {
    installFile(caSrlPath, readFileSync(workSrl), { strict: true })
    installFile(keyPath, readFileSync(workKey), { secret: true })
    installFile(crtPath, readFileSync(workCrt))
  } catch (err) {
    removeServerLeafCert()
    throw err
  }
  normalizeTlsKeyPermissions()
  console.log(`generate-self-signed-cert: wrote ${crtPath}, ${keyPath}, and ${caCrtPath}`)
}

assertLeafNamesSafe()

const expectedSans = subjectAltNames()
const existingSans = readCertSubjectAltNames()
const caReady = existsSync(caCrtPath) && existsSync(caKeyPath)
const rotateRequested = isCaRotateRequested()

if (
  caReady &&
  !rotateRequested &&
  existsSync(crtPath) &&
  existsSync(keyPath) &&
  expectedSans.join(',') === existingSans.join(',') &&
  !serverCertMarkedAsCa()
) {
  // Validate the existing CA (readable + decodable) before treating the leaf
  // as healthy — otherwise a corrupt root is served as ca-bundle.pem.
  ensureCa()
  normalizeTlsKeyPermissions()
  console.log(`generate-self-signed-cert: certificate already up to date at ${certsDir}`)
  process.exit(0)
}

mkdirSync(certsDir, { recursive: true })
mkdirSync(path.dirname(caCrtPath), { recursive: true, mode: 0o750 })

if (existsSync(crtPath) || existsSync(keyPath)) {
  let reason = 'interface addresses or DNS names changed'
  if (serverCertMarkedAsCa()) {
    reason = 'server certificate was marked as a CA'
  } else if (rotateRequested) {
    reason = 'platform CA rotation requested'
  } else if (!caReady) {
    reason = 'local CA is missing'
  }
  console.log(`generate-self-signed-cert: ${reason}; regenerating server certificate`)
  removeServerLeafCert()
}

try {
  ensureCa()
  generateServerCert(expectedSans)
} catch (err) {
  cleanupWorkDir()
  console.error(`generate-self-signed-cert: failed to generate certificate: ${err.message}`)
  console.error('generate-self-signed-cert: ensure openssl is installed at /usr/bin/openssl')
  process.exit(1)
}
cleanupWorkDir()
