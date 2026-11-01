/**
 * `pnpm identity:set`: the final line, the no-overwrite rule, the signed-out
 * message and that no secret material reaches the output. Wrangler, the
 * network, the clock and sleeping are all fakes.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { Buffer } from 'node:buffer'
import { setIdentityKey } from './set-identity-key.mjs'

/** Jest/Mocha-shaped alias so Sonar sees real tests (see check-deploy-env.test.ts). */
const test = Deno.test.bind(Deno)

const PKCS8 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]
const PATH = '/api/daemon/v1/instance/identity'

type Binding = {
  current: { kid: string; priv: string }
  seal: { priv: string }
}
type Run = { args: string[]; input: string }

/** A panel that serves a signed identity document for whatever key was last put. */
function fakeWorld(
  opts: {
    signedIn?: boolean
    startKey?: Binding
    putStatus?: number
    applies?: boolean
  } = {}
) {
  const output: string[] = []
  const runs: Run[] = []
  let live: Binding | undefined = opts.startKey
  let clock = 0
  async function serve(binding: Binding) {
    const seed = new Uint8Array(Buffer.from(binding.current.priv, 'base64url'))
    const key = await crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array([...PKCS8, ...seed]),
      { name: 'Ed25519' },
      true,
      ['sign']
    )
    const jwk = await crypto.subtle.exportKey('jwk', key)
    const body = JSON.stringify({
      keys: [{ kid: binding.current.kid, role: 'current', pub: jwk.x }],
    })
    const message = new TextEncoder().encode(`tp-http\n${PATH}\n${body}`)
    const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, message)).toString('base64url')
    return new Response(body, {
      headers: { 'x-turbopanel-signature': `${binding.current.kid}:${sig}` },
    })
  }
  const deps = {
    run(args: string[], input: string) {
      runs.push({ args, input })
      if (args[0] === 'whoami') {
        return opts.signedIn === false
          ? { status: 0, stdout: 'You are not authenticated.', stderr: '' }
          : { status: 0, stdout: 'signed in', stderr: '' }
      }
      if (opts.putStatus) {
        return { status: opts.putStatus, stdout: '', stderr: 'boom' }
      }
      if (opts.applies !== false) live = JSON.parse(input)
      return { status: 0, stdout: '', stderr: '' }
    },
    fetch: (_url: string) =>
      live
        ? serve(live)
        : Promise.resolve(
            new Response('{"error":"panel identity not configured"}', { status: 404 })
          ),
    sleep: (ms: number) => {
      clock += ms
      return Promise.resolve()
    },
    now: () => clock,
    out: (line: string) => output.push(line),
    host: (env: string) => `${env}.example.test`,
  }
  return { deps, output, runs }
}

async function existingKey(): Promise<Binding> {
  const world = fakeWorld()
  await setIdentityKey(['--env', 'testing'], world.deps)
  return JSON.parse(world.runs[1].input)
}

test('sets the key and prints one fingerprint line', async () => {
  const world = fakeWorld()
  assertEquals(await setIdentityKey(['--env', 'testing'], world.deps), 0)
  const binding: Binding = JSON.parse(world.runs[1].input)
  assertEquals(world.runs[1].args, [
    'secret',
    'put',
    'TURBOPANEL_IDENTITY_KEYS',
    '--env',
    'testing',
  ])
  assertEquals(
    world.output.at(-1),
    `Testing control plane identity key set. Fingerprint (a public code, safe to share): ${binding.current.kid}`
  )
  assert(!('next' in binding))
})

test('refuses to overwrite an existing key without --replace', async () => {
  const world = fakeWorld({ startKey: await existingKey() })
  assertEquals(await setIdentityKey(['--env', 'staging'], world.deps), 1)
  assertEquals(world.runs.filter((r) => r.args[0] === 'secret').length, 0)
  assertStringIncludes(world.output.at(-1)!, '--replace')
})

test('a panel that answers with an error is never overwritten', async () => {
  const world = fakeWorld({ startKey: await existingKey() })
  world.deps.fetch = () => Promise.resolve(new Response('down', { status: 503 }))
  assertEquals(await setIdentityKey(['--env', 'testing'], world.deps), 1)
  assertEquals(world.runs.filter((r) => r.args[0] === 'secret').length, 0)
  assertStringIncludes(world.output.at(-1)!, 'Unexpected answer')
})

test('--replace warns and waits for the new fingerprint, not the old one', async () => {
  const world = fakeWorld({ startKey: await existingKey() })
  assertEquals(await setIdentityKey(['--env', 'live', '--replace'], world.deps), 0)
  assertStringIncludes(world.output.join('\n'), 're-learn')
  const binding: Binding = JSON.parse(world.runs[1].input)
  assertStringIncludes(world.output.at(-1)!, binding.current.kid)
})

test('not signed in prints the sign-in line and exits non-zero', async () => {
  const world = fakeWorld({ signedIn: false })
  assertEquals(await setIdentityKey(['--env', 'testing'], world.deps), 1)
  assertEquals(world.output, ['Sign in to Cloudflare first: ./node_modules/.bin/wrangler login'])
  assertEquals(world.runs.length, 1)
})

test('a timeout after a successful put still prints the fingerprint, with a caveat', async () => {
  const world = fakeWorld({ applies: false })
  assertEquals(await setIdentityKey(['--env', 'testing'], world.deps), 0)
  const binding: Binding = JSON.parse(world.runs[1].input)
  assertStringIncludes(world.output.at(-2)!, 'has not picked it up yet')
  assertStringIncludes(world.output.at(-1)!, binding.current.kid)
})

async function refusesWith(respond: () => Response, extra: string[] = []) {
  const world = fakeWorld()
  world.deps.fetch = () => Promise.resolve(respond())
  assertEquals(await setIdentityKey(['--env', 'live', ...extra], world.deps), 1)
  assertEquals(world.runs.filter((r) => r.args[0] === 'secret').length, 0)
  assertStringIncludes(world.output.at(-1)!, 'Unexpected answer')
}

test('a stray 404 with another body never counts as no key, even with --replace', async () => {
  await refusesWith(() => new Response('<html>not found</html>', { status: 404 }))
  await refusesWith(() => new Response('{"error":"nope"}', { status: 404 }), ['--replace'])
})

test('an unsigned or app-shell 200 is an unexpected answer', async () => {
  await refusesWith(() => new Response('<html>app</html>', { status: 200 }))
  await refusesWith(() => new Response('{"keys":[]}', { status: 200 }), ['--replace'])
})

test('--url is no longer an option', async () => {
  const world = fakeWorld()
  assertEquals(await setIdentityKey(['--env', 'live', '--url', 'https://x.test'], world.deps), 1)
  assertEquals(world.runs.length, 0)
})

test('a whoami network failure says so instead of asking to sign in', async () => {
  const world = fakeWorld()
  world.deps.run = () => ({ status: 1, stdout: '', stderr: 'TypeError: fetch failed' })
  assertEquals(await setIdentityKey(['--env', 'testing'], world.deps), 1)
  assertStringIncludes(world.output.at(-1)!, 'Could not reach Cloudflare')
})

test('no secret material is ever printed, on any path', async () => {
  for (const opts of [{}, { putStatus: 1 }, { applies: false }]) {
    const world = fakeWorld(opts)
    await setIdentityKey(['--env', 'testing'], world.deps)
    const put = world.runs.find((r) => r.args[0] === 'secret')
    if (!put) continue
    const binding: Binding = JSON.parse(put.input)
    const text = world.output.join('\n')
    assert(!text.includes(binding.current.priv))
    assert(!text.includes(binding.seal.priv))
    assert(!text.includes(put.input))
  }
})
