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
 * 3. After Enter, the script asks the control plane whether an approved change
 *    for exactly this key is stored. Only then does the key go to
 *    `wrangler secret put TURBOPANEL_IDENTITY_KEYS` over stdin: a key no
 *    approved change leads to would cut every server off. The script then
 *    waits until the control plane signs with it. The approved change is
 *    served to servers from that moment.
 *
 * If it stops after the approval and before the key is stored, the approved
 * change keeps waiting and blocks every other change: cancel it on Control
 * Plane Identity (Cancel Waiting Change), then run this again.
 *
 * The sealing key is replaced too (the secret holds both and cannot be read
 * back). Run it on a trusted machine (docs/deploying-workers.md).
 */
import { pathToFileURL } from 'node:url'
import { buildBinding, ed25519PublicKey } from './generate-identity-key.mjs'
import { hostForEnv, verifiedFingerprint } from './set-identity-key.mjs'

const ENVS = new Set(['testing', 'staging', 'live'])
const IDENTITY_PATH = '/api/daemon/v1/instance/identity'
const WAITING_PATH = '/api/daemon/v1/instance/identity/statements/waiting/'
const SIGNATURE_HEADER = 'x-turbopanel-signature'
const SECRET_NAME = 'TURBOPANEL_IDENTITY_KEYS'
const POLL_LIMIT_MS = 180_000
const POLL_STEP_MS = 3_000
/** How many times the approval prompt is asked before the command gives up. */
const APPROVAL_CHECKS = 20
/** How many times a refused key is offered again. */
const PUT_TRIES = 3
const CANCEL_HINT =
  'Cancel it on Control Plane Identity (Cancel Waiting Change) before you start again.'

class Stop extends Error {}

function parseArgs(argv) {
  const at = argv.indexOf('--env')
  const opts = { env: at === -1 ? undefined : argv[at + 1], revoke: argv.includes('--revoke') }
  const known = new Set(['--revoke', '--env', opts.env])
  const stray = argv.find((arg) => !known.has(arg))
  if (stray !== undefined) throw new Stop(`Unknown option ${stray}.`)
  if (!ENVS.has(opts.env)) {
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
 * The approved change that waits for the key with this fingerprint: its facts,
 * `null` when none is stored, `undefined` when the control plane could not be
 * asked.
 */
async function readWaitingChange(deps, host, fingerprint) {
  try {
    const response = await deps.fetch(new URL(WAITING_PATH + fingerprint, `https://${host}`).href, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 404) return null
    if (response.status !== 200) return undefined
    const body = await response.json()
    return typeof body === 'object' && body !== null ? body : undefined
  } catch {
    return undefined
  }
}

/** What to say when the owner stops at the approval prompt: only what is true. */
function stoppedMessage(waiting) {
  if (waiting === null) return 'Stopped. Nothing was changed.'
  if (waiting === undefined) {
    return (
      'Stopped. The key was not stored. The control plane could not be asked whether a change ' +
      'was approved: look at Control Plane Identity and cancel a waiting change there.'
    )
  }
  return `Stopped. The key was not stored, but key set ${waiting.keyset} was approved and is still waiting. ${CANCEL_HINT}`
}

/**
 * Wait until the control plane holds an approved change for exactly this key.
 * Never returns on the owner's word alone: Enter only asks again.
 */
async function waitForApproval(deps, host, want) {
  let reachable = true
  for (let asked = 0; asked < APPROVAL_CHECKS; asked += 1) {
    const proceed = await deps.confirm(
      'Press Enter once the change is approved (or type no to stop): '
    )
    const waiting = await readWaitingChange(deps, host, want.current)
    if (!proceed) throw new Stop(stoppedMessage(waiting))
    reachable = waiting !== undefined
    if (waiting === undefined) {
      deps.out(
        'Could not ask the control plane whether the change is stored. The key was not stored.'
      )
      continue
    }
    if (waiting === null) {
      deps.out('No approved change for this key is stored yet. Approve it in the browser first.')
      continue
    }
    const matches =
      waiting.current === want.current &&
      waiting.prev === want.prev &&
      waiting.kind === want.kind &&
      Number.isSafeInteger(waiting.keyset) &&
      waiting.keyset > want.keyset
    if (!matches) {
      throw new Stop(
        `The approved change does not match this command (it must be a ${want.kind} from the current key). ` +
          `The key was not stored. ${CANCEL_HINT}`
      )
    }
    return waiting
  }
  throw new Stop(
    reachable
      ? 'No approved change for this key was found. Nothing was changed.'
      : 'The control plane could not be asked whether a change was approved. The key was not stored: look at Control Plane Identity and cancel a waiting change there.'
  )
}

/** Store the key, offering a refused put again. True once the control plane has it. */
async function putKey(deps, opts, url, binding) {
  for (let tried = 1; tried <= PUT_TRIES; tried += 1) {
    deps.out(`Setting the ${opts.env} key...`)
    const put = deps.run(['secret', 'put', SECRET_NAME, '--env', opts.env], JSON.stringify(binding))
    if (put.status === 0) return true
    // A refused put may still have landed: the served key says which.
    try {
      if ((await readDocument(deps, url))?.kid === binding.current.kid) return true
    } catch {
      // Not readable right now; treat the put as refused.
    }
    deps.out('The key was not accepted.')
    if (tried === PUT_TRIES) break
    if (!(await deps.confirm('Press Enter to try again (or type no to stop): '))) break
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
    const made = await buildBinding()
    const pub = await ed25519PublicKey(made.current.priv)
    const kind = opts.revoke ? 'revoke' : 'rotate'
    const link = `https://${host}/admin/access/panel-identity?${kind}=${pub}`
    deps.out(`Current key: ${before.kid}`)
    deps.out(`New key:     ${made.current.kid}`)
    deps.out(`Open this link, check the new key matches, and approve with a rotation passkey:`)
    deps.out(link)
    const approved = await waitForApproval(deps, host, {
      current: made.current.kid,
      prev: before.kid,
      kind,
      keyset: before.keyset,
    })
    const binding = { ...made, keyset: approved.keyset }
    if (!(await putKey(deps, opts, url, binding))) {
      throw new Stop(
        `The new key was not stored, and it is gone when this command ends. Key set ${approved.keyset} is approved and still waiting. ${CANCEL_HINT}`
      )
    }
    deps.out('Waiting for the control plane to start using it...')
    if (!(await pollForKey(deps, url, binding.current.kid))) {
      deps.out(
        'The key was stored; the control plane has not picked it up yet. Check again in a minute, and do not cancel the waiting change.'
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
  // Asked more than once: the earlier answer paused the stream.
  process.stdin.resume()
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
