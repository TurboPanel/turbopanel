#!/usr/bin/env node
/**
 * Generate a panel identity key for the Workers secret binding
 * `TURBOPANEL_IDENTITY_KEYS` (docs/deploying-workers.md, "Panel identity key").
 * Stores nothing. Run once per environment; testing, staging and live each get
 * their own key.
 *
 *   node scripts/generate-identity-key.mjs            JSON for `wrangler secret put` on stdout,
 *                                                     fingerprints on stderr
 *   node scripts/generate-identity-key.mjs --next-only  one offline seed on stdout (keep it off the
 *                                                     panel) and its fingerprint on stderr
 *
 * Owners use `pnpm identity:set --env <env>` (scripts/set-identity-key.mjs), which reuses
 * `buildBinding` and never writes the key to disk. Pass the `next` fingerprint into the binding by re-running with
 * `--next <fingerprint>`.
 */
import { Buffer } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const { subtle } = webcrypto

const PKCS8_PREFIX = {
  Ed25519: [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ],
  X25519: [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
  ],
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

export async function newKey(algorithm) {
  const seed = webcrypto.getRandomValues(new Uint8Array(32))
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX[algorithm], ...seed])
  const usages = algorithm === 'Ed25519' ? ['sign'] : ['deriveBits']
  const key = await subtle.importKey('pkcs8', pkcs8, { name: algorithm }, true, usages)
  const jwk = await subtle.exportKey('jwk', key)
  const raw = Buffer.from(jwk.x, 'base64url')
  const digest = new Uint8Array(await subtle.digest('SHA-256', raw))
  return { kid: b64url(digest), priv: b64url(seed) }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** The Workers secret binding: a signing key and a sealing key, plus an optional `next` fingerprint. */
export async function buildBinding(next) {
  const current = await newKey('Ed25519')
  const seal = await newKey('X25519')
  return { keyset: 1, current, seal, ...(next ? { next: { kid: next } } : {}) }
}

async function main() {
  if (process.argv.includes('--next-only')) {
    const next = await newKey('Ed25519')
    console.error(`next fingerprint: ${next.kid}`)
    console.log(next.priv)
    return
  }
  const next = argValue('--next')
  if (next !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(next)) {
    console.error('--next must be a 43-character fingerprint')
    process.exit(1)
  }
  const binding = await buildBinding(next)
  console.error(`current fingerprint: ${binding.current.kid}`)
  console.error(`seal fingerprint:    ${binding.seal.kid}`)
  console.log(JSON.stringify(binding))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
