#!/usr/bin/env node
/**
 * Generate a self-signed TLS certificate for local development.
 *
 * Produces certs/dev.crt and certs/dev.key (gitignored) for use by Caddy with
 * `auto_https off` -- no ACME / Let's Encrypt involved. The cert covers
 * localhost, loopback, and all non-loopback interface addresses so HTTPS works
 * when visiting the machine by LAN IP (e.g. https://10.0.0.5:8443).
 *
 * Regenerates automatically when interface addresses change.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const certsDir = path.join(repoRoot, 'certs')
const crtPath = path.join(certsDir, 'dev.crt')
const keyPath = path.join(certsDir, 'dev.key')

function fail(msg) {
  console.error(`generate-dev-cert: ${msg}`)
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

function devSubjectAltNames() {
  const sans = new Set(['DNS:localhost', 'IP:127.0.0.1', 'IP:0:0:0:0:0:0:0:1'])

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

function readCertSubjectAltNames() {
  if (!existsSync(crtPath)) return []

  try {
    const out = execFileSync(
      'openssl',
      ['x509', '-in', crtPath, '-noout', '-ext', 'subjectAltName'],
      { encoding: 'utf8' }
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

function removeCertFiles() {
  for (const file of [crtPath, keyPath]) {
    if (existsSync(file)) unlinkSync(file)
  }
}

const expectedSans = devSubjectAltNames()
const existingSans = readCertSubjectAltNames()

if (
  existsSync(crtPath) &&
  existsSync(keyPath) &&
  expectedSans.join(',') === existingSans.join(',')
) {
  console.log(`generate-dev-cert: certs already up to date at ${certsDir}`)
  process.exit(0)
}

if (existsSync(crtPath) || existsSync(keyPath)) {
  console.log('generate-dev-cert: interface addresses changed; regenerating certificate')
  removeCertFiles()
}

mkdirSync(certsDir, { recursive: true })

const subject = '/CN=turbopanel-dev'
const sans = `subjectAltName=${expectedSans.join(',')}`
const days = '3650'

try {
  console.log(`generate-dev-cert: generating self-signed certificate (10y, ${expectedSans.join(', ')})`)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey', 'rsa:2048',
      '-nodes',
      '-keyout', keyPath,
      '-out', crtPath,
      '-days', days,
      '-subj', subject,
      '-addext', sans,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  )
  console.log(`generate-dev-cert: wrote ${crtPath} and ${keyPath}`)
} catch (err) {
  console.error(`generate-dev-cert: failed to generate certificate: ${err.message}`)
  console.error('generate-dev-cert: ensure openssl is installed and on PATH')
  process.exit(1)
}
