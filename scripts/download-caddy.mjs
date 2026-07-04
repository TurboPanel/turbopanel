#!/usr/bin/env node
/**
 * Download Caddy into the shared runtimes directory and symlink "current".
 *
 * Mirrors the daemon caddy role layout (managed-install default):
 *   /opt/turbopanel/vendor/caddy/<version>/caddy
 *   /opt/turbopanel/vendor/caddy/current -> <version>
 *
 * Idempotent: skips the download if the pinned binary already exists, and
 * always refreshes the "current" symlink to point at the pinned version.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, existsSync, symlinkSync, unlinkSync, copyFileSync, chmodSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveRuntimesDir } from './runtime-paths.mjs'

const TURBOPANEL_RUNTIMES_DIR = resolveRuntimesDir()
const CADDY_VERSION = '2.10.2'
const CADDY_RELEASE_TAG = 'v2.10.2'

const ARCH_MAP = {
  arm64: 'arm64',
  x64: 'amd64',
}

function fail(msg) {
  console.error(`download-caddy: ${msg}`)
  process.exit(1)
}

const arch = ARCH_MAP[process.arch]
if (!arch) {
  fail(`unsupported architecture: ${process.arch} (supported: ${Object.keys(ARCH_MAP).join(', ')})`)
}
if (process.platform !== 'linux') {
  fail(`unsupported platform: ${process.platform} (only linux is supported)`)
}

const caddyRoot = path.join(TURBOPANEL_RUNTIMES_DIR, 'caddy')
const versionDir = path.join(caddyRoot, CADDY_VERSION)
const binPath = path.join(versionDir, 'caddy')
const currentLink = path.join(caddyRoot, 'current')

function refreshCurrentSymlink() {
  const target = path.join(caddyRoot, CADDY_VERSION)
  if (existsSync(currentLink) || isSymlink(currentLink)) {
    unlinkSync(currentLink)
  }
  symlinkSync(target, currentLink)
  console.log(`download-caddy: current -> ${CADDY_VERSION}`)
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

if (existsSync(binPath)) {
  console.log(`download-caddy: Caddy ${CADDY_VERSION} already installed at ${binPath}`)
  refreshCurrentSymlink()
  process.exit(0)
}

const assetName = `caddy_${CADDY_VERSION}_linux_${arch}.tar.gz`
const url = `https://github.com/caddyserver/caddy/releases/download/${CADDY_RELEASE_TAG}/${assetName}`

const tmp = mkdtempSync(path.join(tmpdir(), 'caddy-dl-'))
const tarball = path.join(tmp, assetName)

try {
  console.log(`download-caddy: downloading ${url}`)
  execFileSync('curl', ['-fsSL', '-o', tarball, url], { stdio: ['ignore', 'inherit', 'inherit'] })

  console.log('download-caddy: extracting caddy binary')
  execFileSync('tar', ['-xzf', tarball, '-C', tmp, 'caddy'], { stdio: ['ignore', 'inherit', 'inherit'] })

  const extracted = path.join(tmp, 'caddy')
  if (!existsSync(extracted)) {
    fail('extraction did not produce a caddy binary')
  }

  mkdirSync(versionDir, { recursive: true })
  copyFileSync(extracted, binPath)
  chmodSync(binPath, 0o755)
  console.log(`download-caddy: installed ${binPath}`)

  refreshCurrentSymlink()
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
