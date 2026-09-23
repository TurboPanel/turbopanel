#!/usr/bin/env node
/**
 * Instance-ACME boundary check (CI guard).
 *
 * Instance ACME (the control plane's own names) and organization ACME
 * (`organization.options` opt-in, org `tls` rows) must not reference each
 * other. Canonical rule: `src/lib/tls/AGENTS.md` and root `AGENTS.md`
 * (Instance hostnames and instance ACME).
 *
 * Usage:
 *   node scripts/check-instance-acme-boundary.mjs
 *   pnpm check:instance-acme-boundary
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url))

const ORG_TOKENS = [
  'INSTANCE_ACME_SETTINGS',
  'instance-acme-settings.ts',
  'instanceHostname',
  'instanceUploadedCertificate',
]

const INSTANCE_TOKENS = [
  'acmeEnabled',
  'organization-options.ts',
  'resolveAcmeEnabled',
]

const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.turbo',
  'workers',
])

const SCAN_EXTENSIONS = /\.(ts|tsx)$/

function scansFor(root) {
  return [
    {
      roots: [
        path.join(root, 'src/features/organizations'),
        path.join(root, 'src/client/tls'),
        path.join(root, 'src/features/tls'),
        path.join(root, 'src/client/environments'),
      ],
      tokens: ORG_TOKENS,
      why: 'Organization code must not reference instance ACME settings or hostname rows',
    },
    {
      roots: [
        path.join(root, 'src/features/install/instance-acme-settings.ts'),
        path.join(root, 'src/features/install/instance-hostnames.ts'),
        path.join(root, 'src/features/install/instance-certificates.ts'),
        path.join(root, 'src/admin/instance-hostname-routes.ts'),
        path.join(root, 'src/admin/public-urls-apply-payload.ts'),
        path.join(root, 'src/admin/openapi/instance-hostnames.ts'),
        path.join(root, 'src/admin/openapi/instance-access.ts'),
      ],
      tokens: INSTANCE_TOKENS,
      why: 'Instance ACME code must not reference an organization ACME opt-in',
    },
  ]
}

function isTestFile(file) {
  return file.endsWith('.test.ts') || file.endsWith('.test.tsx')
}

function* walk(target, root) {
  if (!fs.existsSync(target)) return
  const stat = fs.statSync(target)
  if (stat.isFile()) {
    yield target
    return
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const abs = path.join(target, entry.name)
    const rel = path.relative(root, abs)
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue
      yield* walk(abs, root)
    } else if (entry.isFile() && rel !== SELF) {
      yield abs
    }
  }
}

/**
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function checkInstanceAcmeBoundary(options = {}) {
  const root = options.root ?? ROOT
  const failures = []
  for (const scan of scansFor(root)) {
    for (const scanRoot of scan.roots) {
      for (const file of walk(scanRoot, root)) {
        if (!SCAN_EXTENSIONS.test(file) || isTestFile(file)) continue
        const rel = path.relative(root, file)
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          for (const token of scan.tokens) {
            if (line.includes(token)) {
              failures.push(
                `${rel}:${i + 1} references "${token}" — ${scan.why}`,
              )
            }
          }
        })
      }
    }
  }
  return failures
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

function main() {
  const failures = checkInstanceAcmeBoundary()
  if (failures.length > 0) {
    console.error('Instance ACME boundary check failed:\n')
    for (const failure of failures) {
      console.error(`  \u2717 ${failure}`)
    }
    console.error(
      `\n${failures.length} problem(s) found. Instance ACME and organization ACME stay separate. ` +
        'See src/lib/tls/AGENTS.md. Do not widen this script\'s allowlist without review.',
    )
    process.exit(1)
  }
  console.log(
    'check-instance-acme-boundary: instance ACME and organization ACME do not reference each other.',
  )
}

if (isDirectRun()) main()
