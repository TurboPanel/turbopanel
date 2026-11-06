#!/usr/bin/env node
/**
 * Set a control plane's identity key on Cloudflare Workers with one command:
 *
 *   pnpm identity:set --env <testing|staging|live> [--replace]
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

const NOT_CONFIGURED_ERROR = 'panel identity not configured'
const NETWORK_ERROR = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network/i

/**
 * Read the identity route. `unset` is true only for the route's own "not configured" 404 body;
 * `kid` is set only for a 200 whose signature verifies. Anything else is "unexpected".
 */
async function readIdentity(deps, url) {
  const response = await deps.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  if (response.status === 404) {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = null
    }
    return { status: 404, unset: parsed?.error === NOT_CONFIGURED_ERROR }
  }
  if (response.status !== 200) return { status: response.status }
  const kid = await verifiedFingerprint(body, response.headers.get(SIGNATURE_HEADER))
  return { status: 200, kid }
}

function parseArgs(argv) {
  const at = argv.indexOf('--env')
  const opts = { env: at === -1 ? undefined : argv[at + 1], replace: argv.includes('--replace') }
  const known = new Set(['--replace', '--env', opts.env])
  const stray = argv.find((arg) => !known.has(arg))
  if (stray !== undefined) throw new Stop(`Unknown option ${stray}.`)
  if (!ENVS.includes(opts.env)) {
    throw new Stop('Usage: pnpm identity:set --env <testing|staging|live> [--replace]')
  }
  return opts
}

async function pollForKey(deps, url, fingerprint) {
  const deadline = deps.now() + POLL_LIMIT_MS
  while (deps.now() < deadline) {
    await deps.sleep(POLL_STEP_MS)
    try {
      const seen = await readIdentity(deps, url)
      if (seen.kid === fingerprint) return true
    } catch {
      // The control plane may be restarting; keep waiting.
    }
  }
  return false
}

/** Proceed only for a signed key we can see (with --replace) or the route's own "not configured" 404. */
async function checkExisting(deps, opts, url, label) {
  let seen
  try {
    seen = await readIdentity(deps, url)
  } catch {
    seen = {}
  }
  if (seen.unset) return
  if (seen.kid && opts.replace) {
    deps.out('Replacing the key: every server will need to re-learn it.')
    return
  }
  if (seen.kid) {
    throw new Stop(
      `${label} already has a control plane identity key. Nothing was changed. To replace it, run again with --replace.`
    )
  }
  throw new Stop(
    `Unexpected answer from ${new URL(url).host} (the control plane answered: ${seen.status ?? 'nothing'}), so it is not clear whether ${label} has a key. Nothing was changed.`
  )
}

function checkSignedIn(deps) {
  const who = deps.run(['whoami'], '')
  const text = `${who.stdout}${who.stderr}`
  if (/not authenticated/i.test(text)) throw new Stop(SIGN_IN)
  if (who.status !== 0 && NETWORK_ERROR.test(text)) {
    throw new Stop(
      'Could not reach Cloudflare to check your sign-in. Check your connection and try again.'
    )
  }
  if (who.status !== 0) throw new Stop(SIGN_IN)
}

/**
 * Run the whole flow. `deps` = { run(args, input) -> {status, stdout, stderr}, fetch, sleep, now,
 * out(line), host(envName) } so tests inject every outside effect. Returns the exit code.
 */
export async function setIdentityKey(argv, deps) {
  try {
    const opts = parseArgs(argv)
    const label = opts.env[0].toUpperCase() + opts.env.slice(1)
    checkSignedIn(deps)
    const url = new URL(IDENTITY_PATH, `https://${deps.host(opts.env)}`).href
    await checkExisting(deps, opts, url, label)
    const binding = await buildBinding()
    deps.out(`Setting the ${opts.env} key on Cloudflare...`)
    const put = deps.run(['secret', 'put', SECRET_NAME, '--env', opts.env], JSON.stringify(binding))
    if (put.status !== 0) {
      throw new Stop('Cloudflare did not accept the key. Nothing was changed. Try again.')
    }
    deps.out('Waiting for the control plane to start using it...')
    if (!(await pollForKey(deps, url, binding.current.kid))) {
      deps.out(
        'The key was stored; the control plane has not picked it up yet. Check again in a minute.'
      )
    }
    deps.out(
      `${label} control plane identity key set. Fingerprint (a public code, safe to share): ${binding.current.kid}`
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
