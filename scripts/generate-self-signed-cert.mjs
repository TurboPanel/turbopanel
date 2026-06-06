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
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
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

function fail(msg) {
  console.error(`generate-self-signed-cert: ${msg}`)
  process.exit(1)
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

function explicitDnsNames() {
  const names = new Set()
  for (const entry of process.env.TURBOPANEL_TLS_EXTRA_SANS?.split(',') ?? []) {
    const trimmed = entry.trim()
    if (trimmed) names.add(trimmed)
  }
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
