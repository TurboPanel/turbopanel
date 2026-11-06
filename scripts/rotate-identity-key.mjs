#!/usr/bin/env node
/**
 * Rotate a High Availability control plane's identity key, approved by the
 * owner's rotation passkeys:
 *
 *   pnpm identity:rotate --env <testing|staging|live> [--revoke]
 *
 * 1. Makes the new key in memory and prints its fingerprint and an approval
 *    link. Nothing is written to disk.
 * 2. The owner opens the link (signed in as a superadmin), checks the
 *    fingerprint matches, and approves with a rotation passkey. The control
 *    plane stores the approved change, waiting for its key.
 * 3. After Enter, the key goes to `wrangler secret put TURBOPANEL_IDENTITY_KEYS`
 *    over stdin; the script waits until the control plane signs with it. The
 *    approved change is served to servers from that moment.
 *
 * The sealing key is replaced too (the secret holds both and cannot be read
 * back). Run it on a trusted machine (docs/deploying-workers.md).
 */
import { pathToFileURL } from 'node:url'
import { buildBinding, ed25519PublicKey } from './generate-identity-key.mjs'
import { hostForEnv, verifiedFingerprint } from './set-identity-key.mjs'

const ENVS = ['testing', 'staging', 'live']
const IDENTITY_PATH = '/api/daemon/v1/instance/identity'
const SIGNATURE_HEADER = 'x-turbopanel-signature'
const SECRET_NAME = 'TURBOPANEL_IDENTITY_KEYS'
const POLL_LIMIT_MS = 180_000
const POLL_STEP_MS = 3_000

class Stop extends Error {}

function parseArgs(argv) {
  const at = argv.indexOf('--env')
  const opts = { env: at === -1 ? undefined : argv[at + 1], revoke: argv.includes('--revoke') }
  const known = new Set(['--revoke', '--env', opts.env])
  const stray = argv.find((arg) => !known.has(arg))
  if (stray !== undefined) throw new Stop(`Unknown option ${stray}.`)
  if (!ENVS.includes(opts.env)) {
    throw new Stop('Usage: pnpm identity:rotate --env <testing|staging|live> [--revoke]')
  }
  return opts
}

/** The served document, checked the way a daemon checks it. */
async function readDocument(deps, url) {
  const response = await deps.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  if (response.status !== 200) return null
  const kid = await verifiedFingerprint(body, response.headers.get(SIGNATURE_HEADER))
  if (!kid) return null
  const doc = JSON.parse(body)
  return { kid, keyset: doc.keyset, passkeys: doc.rotation?.passkeys?.length ?? 0 }
}

async function pollForKey(deps, url, fingerprint) {
  const deadline = deps.now() + POLL_LIMIT_MS
  while (deps.now() < deadline) {
    await deps.sleep(POLL_STEP_MS)
    try {
      if ((await readDocument(deps, url))?.kid === fingerprint) return true
    } catch {
      // The control plane may be restarting; keep waiting.
    }
  }
  return false
}

/**
 * Run the whole flow. `deps` = { run(args, input) -> {status, stdout, stderr}, fetch, sleep, now,
 * out(line), host(envName), confirm(question) -> Promise<boolean> } so tests inject every outside
 * effect. Returns the exit code.
 */
export async function rotateIdentityKey(argv, deps) {
  try {
    const opts = parseArgs(argv)
    const host = deps.host(opts.env)
    const url = new URL(IDENTITY_PATH, `https://${host}`).href
    let before = null
    try {
      before = await readDocument(deps, url)
    } catch {
      before = null
    }
    if (!before) {
      throw new Stop(`Could not read a signed key from ${host}. Nothing was changed.`)
    }
    if (before.passkeys < 2) {
      throw new Stop(
        'Mark at least two rotation passkeys on Control Plane Identity first. Nothing was changed.'
      )
    }
    const binding = { ...(await buildBinding()), keyset: before.keyset + 1 }
    const pub = await ed25519PublicKey(binding.current.priv)
    const link = `https://${host}/admin/access/panel-identity?${opts.revoke ? 'revoke' : 'rotate'}=${pub}`
    deps.out(`Current key: ${before.kid}`)
    deps.out(`New key:     ${binding.current.kid}`)
    deps.out(`Open this link, check the new key matches, and approve with a rotation passkey:`)
    deps.out(link)
    if (!(await deps.confirm('Press Enter once the change is approved (or type no to stop): '))) {
      throw new Stop('Stopped. The new key was not stored anywhere.')
    }
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
      return 0
    }
    deps.out(`Done. Servers move to ${binding.current.kid} as they see the change.`)
    return 0
  } catch (err) {
    if (!(err instanceof Stop)) throw err
    deps.out(err.message)
    return 1
  }
}

function realConfirm(question) {
  process.stdout.write(question)
  return new Promise((resolve) => {
    process.stdin.once('data', (data) => {
      process.stdin.pause()
      resolve(!/^\s*no?\s*$/i.test(String(data)))
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { realRun } = await import('./set-identity-key.mjs')
  const code = await rotateIdentityKey(process.argv.slice(2), {
    run: realRun,
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    out: (line) => console.log(line),
    host: hostForEnv,
    confirm: realConfirm,
  })
  process.exit(code)
}
