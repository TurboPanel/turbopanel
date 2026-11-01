#!/usr/bin/env node
/**
 * Set a panel's identity key on Cloudflare Workers with one command:
 *
 *   pnpm identity:set --env <testing|staging|live> [--replace] [--url <https://host>]
 *
 * The key is generated in memory and piped to `wrangler secret put
 * TURBOPANEL_IDENTITY_KEYS` over stdin; it is never written to disk or printed.
 * The script then waits until the panel's identity route serves a document
 * signed by the new key and prints its fingerprint. An environment that already
 * has a key is left alone unless `--replace` is given. Run it on a trusted
 * machine, never against a server (docs/deploying-workers.md).
 */
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { webcrypto } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripJsonc } from './check-deploy-env.mjs'
import { buildBinding } from './generate-identity-key.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENVS = ['testing', 'staging', 'live']
const IDENTITY_PATH = '/api/daemon/v1/instance/identity'
const SIGNATURE_HEADER = 'x-turbopanel-signature'
const SECRET_NAME = 'TURBOPANEL_IDENTITY_KEYS'
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler')
const POLL_LIMIT_MS = 120_000
const POLL_STEP_MS = 3_000
const SIGN_IN = 'Sign in to Cloudflare first: ./node_modules/.bin/wrangler login'

class Stop extends Error {}

function b64urlBytes(text) {
  return new Uint8Array(Buffer.from(text, 'base64url'))
}

/** Host of the env's routes in wrangler.jsonc, e.g. `testing.turbopanel.dev`. */
export function hostForEnv(envName, wranglerPath = path.join(ROOT, 'wrangler.jsonc')) {
  const config = JSON.parse(stripJsonc(fs.readFileSync(wranglerPath, 'utf8')))
  const pattern = config.env?.[envName]?.routes?.[0]?.pattern
  const host = typeof pattern === 'string' ? pattern.split('/')[0] : ''
  if (!host) throw new Stop(`wrangler.jsonc has no route for the ${envName} environment.`)
  return host
}

/** Check the served document the way a daemon does, and return the fingerprint of its current key. */
export async function verifiedFingerprint(body, header) {
  try {
    const doc = JSON.parse(body)
    const current = (doc.keys ?? []).filter((k) => k.role === 'current')
    const [kid, sig, ...rest] = (header ?? '').split(':')
    if (current.length !== 1 || !kid || !sig || rest.length > 0 || kid !== current[0].kid) {
      return null
    }
    const pub = b64urlBytes(current[0].pub)
    const digest = await webcrypto.subtle.digest('SHA-256', pub)
    if (Buffer.from(digest).toString('base64url') !== kid) return null
    const key = await webcrypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])
    const message = new TextEncoder().encode(`tp-http\n${IDENTITY_PATH}\n${body}`)
    return (await webcrypto.subtle.verify('Ed25519', key, b64urlBytes(sig), message)) ? kid : null
  } catch {
    return null
  }
}

async function readIdentity(deps, url) {
  const response = await deps.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  if (response.status !== 200) return { status: response.status }
  const body = await response.text()
  const kid = await verifiedFingerprint(body, response.headers.get(SIGNATURE_HEADER))
  return { status: 200, kid }
}

function parseArgs(argv) {
  const opts = { env: undefined, url: undefined, replace: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--replace') opts.replace = true
    else if (argv[i] === '--env') opts.env = argv[++i]
    else if (argv[i] === '--url') opts.url = argv[++i]
    else throw new Stop(`Unknown option ${argv[i]}.`)
  }
  if (!ENVS.includes(opts.env)) {
    throw new Stop('Usage: pnpm identity:set --env <testing|staging|live> [--replace]')
  }
  return opts
}

function identityUrl(opts, host) {
  const base = opts.url ?? `https://${host()}`
  try {
    return new URL(IDENTITY_PATH, base).href
  } catch {
    throw new Stop('--url must be a full web address such as https://testing.turbopanel.dev')
  }
}

async function pollForKey(deps, url, fingerprint) {
  const deadline = deps.now() + POLL_LIMIT_MS
  while (deps.now() < deadline) {
    await deps.sleep(POLL_STEP_MS)
    try {
      const seen = await readIdentity(deps, url)
      if (seen.status === 200 && seen.kid === fingerprint) return
    } catch {
      // The panel may be restarting; keep waiting.
    }
  }
  throw new Stop(
    'The panel did not start using the new key within 2 minutes. Run the same command again with --replace.'
  )
}

/** Stop unless the env is known to have no key (404), or `--replace` says to go ahead. */
async function checkExisting(deps, opts, url, label) {
  let status
  try {
    status = (await readIdentity(deps, url)).status
  } catch {
    status = 'no answer'
  }
  if (status === 404) return
  if (status === 200 && opts.replace) {
    deps.out('Replacing the key: every server will need to re-learn it.')
    return
  }
  if (status === 200) {
    throw new Stop(
      `${label} already has a panel identity key. Nothing was changed. To replace it, run again with --replace.`
    )
  }
  if (opts.replace) return
  throw new Stop(
    `Could not tell whether ${label} already has a key (the panel answered: ${status}). Nothing was changed.`
  )
}

/**
 * Run the whole flow. `deps` = { run(args, input) -> {status, stdout, stderr}, fetch, sleep, now,
 * out(line), host(envName) } so tests inject every outside effect. Returns the exit code.
 */
export async function setIdentityKey(argv, deps) {
  try {
    const opts = parseArgs(argv)
    const label = opts.env[0].toUpperCase() + opts.env.slice(1)
    const who = deps.run(['whoami'], '')
    if (who.status !== 0 || /not authenticated/i.test(`${who.stdout}${who.stderr}`)) {
      throw new Stop(SIGN_IN)
    }
    const url = identityUrl(opts, () => deps.host(opts.env))
    await checkExisting(deps, opts, url, label)
    const binding = await buildBinding()
    deps.out(`Setting the ${opts.env} key on Cloudflare...`)
    const put = deps.run(['secret', 'put', SECRET_NAME, '--env', opts.env], JSON.stringify(binding))
    if (put.status !== 0) {
      throw new Stop('Cloudflare did not accept the key. Nothing was changed. Try again.')
    }
    deps.out('Waiting for the panel to start using it...')
    await pollForKey(deps, url, binding.current.kid)
    deps.out(
      `${label} panel identity key set. Fingerprint (a public code, safe to share): ${binding.current.kid}`
    )
    return 0
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    deps.out(err.message)
    return 1
  }
}

function realRun(args, input) {
  const result = spawnSync(WRANGLER, args, { cwd: ROOT, input, encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') {
    console.log('Run `pnpm install` first: wrangler is not installed here.')
    process.exit(1)
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await setIdentityKey(process.argv.slice(2), {
    run: realRun,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    out: (line) => console.log(line),
    host: hostForEnv,
  })
  process.exit(code)
}
