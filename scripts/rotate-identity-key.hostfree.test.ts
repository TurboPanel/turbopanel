/**
 * `pnpm identity:rotate` and the `--replace` refusal of `pnpm identity:set`
 * once rotation passkeys exist. Wrangler, the network, the clock, sleeping and
 * the Enter prompt are all fakes.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { Buffer } from 'node:buffer'
import { buildBinding, ed25519PublicKey } from './generate-identity-key.mjs'
import { rotateIdentityKey } from './rotate-identity-key.mjs'
import { setIdentityKey } from './set-identity-key.mjs'

const test = Deno.test.bind(Deno)

const PKCS8 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]
const PATH = '/api/daemon/v1/instance/identity'
const WAITING = `${PATH}/statements/waiting/`

type Binding = { keyset: number; current: { kid: string; priv: string } }

async function serve(binding: Binding, passkeys: number): Promise<Response> {
  const seed = new Uint8Array(Buffer.from(binding.current.priv, 'base64url'))
  const key = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array([...PKCS8, ...seed]),
    { name: 'Ed25519' },
    true,
    ['sign']
  )
  const jwk = await crypto.subtle.exportKey('jwk', key)
  const rotation = { rpId: 'x', passkeys: Array.from({ length: passkeys }, () => ({})) }
  const body = JSON.stringify({
    keys: [{ kid: binding.current.kid, role: 'current', pub: jwk.x }],
    keyset: binding.keyset,
    ...(passkeys > 0 ? { rotation } : {}),
  })
  const message = new TextEncoder().encode(`tp-http\n${PATH}\n${body}`)
  const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, message)).toString('base64url')
  return new Response(body, {
    headers: { 'x-turbopanel-signature': `${binding.current.kid}:${sig}` },
  })
}

type WorldOptions = {
  passkeys?: number
  /** What the owner answers at each prompt (default: Enter every time). */
  answers?: readonly boolean[]
  putStatus?: number
  /** A refused put that stored the key all the same. */
  putLandsAnyway?: boolean
  /** The waiting change the control plane holds: none, or one that differs from the command. */
  stored?: 'none' | 'after-second-ask' | 'other-kind' | 'other-prev' | 'unreachable'
}

async function world(opts: WorldOptions = {}) {
  const output: string[] = []
  const puts: string[] = []
  const prompts: string[] = []
  let live: Binding = { ...(await buildBinding()), keyset: 4 }
  let clock = 0
  let asks = 0
  /** The control plane's answer about a change waiting for `fingerprint`. */
  const waiting = (fingerprint: string): Response => {
    asks += 1
    const stored = opts.stored
    if (stored === 'unreachable') return new Response('{}', { status: 503 })
    if (stored === 'none' || (stored === 'after-second-ask' && asks < 2)) {
      return Response.json({ error: 'no change waits for this key' }, { status: 404 })
    }
    return Response.json({
      keyset: live.keyset + 1,
      kind: stored === 'other-kind' ? 'revoke' : 'rotate',
      prev: stored === 'other-prev' ? 'x'.repeat(43) : live.current.kid,
      current: fingerprint,
    })
  }
  const deps = {
    run(args: string[], input: string) {
      if (args[0] === 'whoami') return { status: 0, stdout: 'ok', stderr: '' }
      puts.push(input)
      if ((opts.putStatus ?? 0) === 0 || opts.putLandsAnyway) live = JSON.parse(input)
      return { status: opts.putStatus ?? 0, stdout: '', stderr: '' }
    },
    fetch: (url: string) => {
      const at = url.indexOf(WAITING)
      return at === -1
        ? serve(live, opts.passkeys ?? 2)
        : Promise.resolve(waiting(url.slice(at + WAITING.length)))
    },
    sleep: () => {
      clock += 3_000
      return Promise.resolve()
    },
    now: () => clock,
    out: (line: string) => output.push(line),
    host: () => 'testing.example.test',
    confirm: (question: string) => {
      prompts.push(question)
      return Promise.resolve(opts.answers?.[prompts.length - 1] ?? true)
    },
  }
  return { deps, output, puts, prompts, live: () => live, asks: () => asks }
}

test('a rotation prints the approval link, puts the key after Enter and waits for it', async () => {
  const w = await world()
  const before = w.live().current.kid
  assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 0)
  assertEquals(w.puts.length, 1)
  const put = JSON.parse(w.puts[0]!) as Binding
  // The key set of the stored change, not a guess from the document.
  assertEquals(put.keyset, 5)
  const link = w.output.find((line) => line.startsWith('https://'))
  assertEquals(
    link,
    `https://testing.example.test/admin/access/panel-identity?rotate=${await ed25519PublicKey(put.current.priv)}`
  )
  assert(w.output.some((line) => line.includes(before)))
  assertStringIncludes(w.output.at(-1)!, put.current.kid)
  // The private key never reaches the output.
  assert(!w.output.join('\n').includes(put.current.priv))
})

test('a revoke links to the revoke approval and needs a stored revoke', async () => {
  // The stored change is a revoke, the command asked for one: it goes through.
  const w = await world({ stored: 'other-kind' })
  assertEquals(await rotateIdentityKey(['--env', 'testing', '--revoke'], w.deps), 0)
  assert(w.output.some((line) => line.includes('/admin/access/panel-identity?revoke=')))
  assertEquals(w.puts.length, 1)
})

test('Enter alone never stores the key: an approved change for it must be stored', async () => {
  const w = await world({ stored: 'none' })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 1)
  assertEquals(w.puts.length, 0)
  // It asked every time and was told there is nothing, every time.
  assertEquals(w.asks(), w.prompts.length)
  assert(w.asks() > 1)
  assertStringIncludes(w.output.at(-1)!, 'Nothing was changed.')
  assert(w.output.some((line) => line.includes('No approved change for this key is stored yet')))
})

test('the key is stored once the approval shows up on a later Enter', async () => {
  const w = await world({ stored: 'after-second-ask' })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 0)
  assertEquals([w.asks(), w.puts.length], [2, 1])
})

test('an approved change that is not this command is never followed by the key', async () => {
  for (const stored of ['other-kind', 'other-prev'] as const) {
    const w = await world({ stored })
    assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 1, stored)
    assertEquals(w.puts.length, 0, stored)
    assertStringIncludes(w.output.at(-1)!, 'The key was not stored.')
    assertStringIncludes(w.output.at(-1)!, 'Cancel Waiting Change')
    assert(!w.output.join('\n').includes('Nothing was changed'), stored)
  }
})

test('when the control plane cannot be asked, nothing is stored', async () => {
  const w = await world({ stored: 'unreachable' })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 1)
  assertEquals(w.puts.length, 0)
  // An approval may be stored for all this command knows: it does not claim otherwise.
  assert(!w.output.join('\n').includes('Nothing was changed'))
  assertStringIncludes(w.output.at(-1)!, 'The key was not stored')
})

test('stopping says what is true: nothing changed, or an approved change still waits', async () => {
  const nothing = await world({ stored: 'none', answers: [false] })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], nothing.deps), 1)
  assertEquals(nothing.output.at(-1), 'Stopped. Nothing was changed.')

  const approved = await world({ answers: [false] })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], approved.deps), 1)
  assertEquals(approved.puts.length, 0)
  assertStringIncludes(approved.output.at(-1)!, 'key set 5 was approved and is still waiting')
  assertStringIncludes(approved.output.at(-1)!, 'Cancel Waiting Change')
  assert(!approved.output.at(-1)!.includes('Nothing was changed'))

  const unknown = await world({ stored: 'unreachable', answers: [false] })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], unknown.deps), 1)
  assertStringIncludes(unknown.output.at(-1)!, 'could not be asked')
  assert(!unknown.output.at(-1)!.includes('Nothing was changed'))
})

test('a refused key is offered again, and the last message says the change still waits', async () => {
  const w = await world({ putStatus: 1 })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 1)
  // One approval prompt, then the key was tried three times.
  assertEquals(w.puts.length, 3)
  const last = w.output.at(-1)!
  assertStringIncludes(last, 'The new key was not stored')
  assertStringIncludes(last, 'Key set 5 is approved and still waiting')
  assertStringIncludes(last, 'Cancel Waiting Change')
  assert(!w.output.join('\n').includes('Nothing was changed'))

  const stopped = await world({ putStatus: 1, answers: [true, false] })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], stopped.deps), 1)
  assertEquals(stopped.puts.length, 1)
})

test('a put that reports failure but stored the key counts as stored', async () => {
  const w = await world({ putStatus: 1, putLandsAnyway: true })
  assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 0)
  assertEquals(w.puts.length, 1)
  assertStringIncludes(w.output.at(-1)!, 'Done.')
})

test('nothing is put without two marked passkeys, an approval or a valid env', async () => {
  for (const [opts, argv] of [
    [{ passkeys: 1 }, ['--env', 'testing']],
    [{ answers: [false] }, ['--env', 'testing']],
    [{}, ['--env', 'nowhere']],
    [{}, ['--env', 'testing', '--force']],
  ] as const) {
    const w = await world(opts)
    assertEquals(await rotateIdentityKey([...argv], w.deps), 1, JSON.stringify(argv))
    assertEquals(w.puts.length, 0)
  }
})

test('identity:set --replace refuses once rotation passkeys exist', async () => {
  const w = await world({ passkeys: 2 })
  assertEquals(await setIdentityKey(['--env', 'testing', '--replace'], w.deps), 1)
  assertEquals(w.puts.length, 0)
  assertStringIncludes(w.output.join('\n'), 'pnpm identity:rotate')
})
