#!/usr/bin/env node
/**
 * Website error appendix check.
 *
 * Lists the snake_case `error: '<code>'` values the client API source returns
 * and fails when one is missing from the website's error-code appendix
 * (`docs/using/reference/errors.mdx` in the website checkout beside this one).
 *
 * Usage:
 *   node scripts/check-error-appendix.mjs                  # exit 1 on a missing code
 *   node scripts/check-error-appendix.mjs --appendix FILE  # read another appendix file
 *
 * Codes that are not client-facing (internal result tags, redirect query
 * values, daemon-only replies) are listed in `NOT_CLIENT_FACING` with the
 * reason, never silently skipped.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from './schema-snapshot.mjs'

export const DEFAULT_APPENDIX = path.resolve(
  REPO_ROOT,
  '../website/docs/using/reference/errors.mdx'
)

const SOURCE_DIRS = ['src/client', 'src/admin', 'src/features', 'src/webhook']

/** Code-looking values the source uses that never reach an API caller as `error`. */
export const NOT_CLIENT_FACING = new Map([
  ['address_unreadable', 'notification emit result, not an HTTP body'],
  ['bad_verification_code', 'GitHub reply the app reads, not one it sends'],
  ['enqueue_failed', 'internal reason tag'],
  ['invalid', 'internal status tag'],
  ['no_email_queue', 'notification emit result, not an HTTP body'],
  ['not_a_ref', 'compose lint tag'],
  ['not_found', 'internal result tag (the 404 body is "Not found")'],
  ['no_eligible_server', 'mapped to server_placement_required before it is sent'],
  ['pin_mismatch', 'mapped to tls_pin_mismatch before it is sent'],
  ['pin_not_found', 'mapped to tls_pin_not_found before it is sent'],
  ['pin_not_ready', 'mapped to tls_pin_not_ready before it is sent'],
  ['rate_limited', 'OAuth callback redirect value, not a JSON body'],
  ['retry', 'webhook gate reply to the git provider'],
  ['unauthorized', 'daemon socket reply, not the client API'],
])

const CODE_PATTERN = /\berror:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+)['"]/g

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) yield full
  }
}

/** Every `error: 'code'` literal in the non-test source under the given roots. */
export function codesInSource(root = REPO_ROOT, dirs = SOURCE_DIRS) {
  const codes = new Set()
  for (const dir of dirs) {
    const abs = path.join(root, dir)
    if (!fs.existsSync(abs)) continue
    for (const file of sourceFiles(abs)) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(CODE_PATTERN)) codes.add(match[1])
    }
  }
  return codes
}

/** Every backtick-quoted code in the first column of an appendix table row. */
export function codesInAppendix(text) {
  const codes = new Set()
  for (const line of text.split('\n')) {
    const cell = /^\|\s*([^|]+?)\s*\|/.exec(line)
    if (!cell) continue
    for (const code of cell[1].matchAll(/`([^`]+)`/g)) codes.add(code[1])
  }
  return codes
}

/** Codes the source returns that the appendix does not list, sorted. */
export function missingFromAppendix(sourceCodes, appendixCodes) {
  return [...sourceCodes]
    .filter((code) => !appendixCodes.has(code) && !NOT_CLIENT_FACING.has(code))
    .toSorted()
}

function main(argv) {
  const flag = argv.indexOf('--appendix')
  const appendix = flag === -1 ? DEFAULT_APPENDIX : path.resolve(argv[flag + 1])
  if (!fs.existsSync(appendix)) {
    console.error(
      `error-appendix: ${appendix} does not exist — pass --appendix FILE or check out the website repo beside this one`
    )
    return 2
  }
  const missing = missingFromAppendix(
    codesInSource(),
    codesInAppendix(fs.readFileSync(appendix, 'utf8'))
  )
  if (missing.length === 0) {
    console.log(`error-appendix: ${appendix} lists every client-facing error code`)
    return 0
  }
  for (const code of missing) console.error(`error-appendix: not listed: ${code}`)
  console.error(
    'error-appendix: add each to docs/using/reference/errors.mdx, or to NOT_CLIENT_FACING with a reason'
  )
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
