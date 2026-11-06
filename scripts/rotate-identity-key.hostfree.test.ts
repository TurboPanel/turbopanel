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

async function world(opts: { passkeys?: number; approve?: boolean; putStatus?: number } = {}) {
  const output: string[] = []
  const puts: string[] = []
  let live: Binding = { ...(await buildBinding()), keyset: 4 }
  let clock = 0
  const deps = {
    run(args: string[], input: string) {
      if (args[0] === 'whoami') return { status: 0, stdout: 'ok', stderr: '' }
      puts.push(input)
      if ((opts.putStatus ?? 0) === 0) live = JSON.parse(input)
      return { status: opts.putStatus ?? 0, stdout: '', stderr: '' }
    },
    fetch: () => serve(live, opts.passkeys ?? 2),
    sleep: () => {
      clock += 3_000
      return Promise.resolve()
    },
    now: () => clock,
    out: (line: string) => output.push(line),
    host: () => 'testing.example.test',
    confirm: () => Promise.resolve(opts.approve ?? true),
  }
  return { deps, output, puts, live: () => live }
}

test('a rotation prints the approval link, puts the key after Enter and waits for it', async () => {
  const w = await world()
  const before = w.live().current.kid
  assertEquals(await rotateIdentityKey(['--env', 'testing'], w.deps), 0)
  assertEquals(w.puts.length, 1)
  const put = JSON.parse(w.puts[0]!) as Binding
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

test('a revoke links to the revoke approval', async () => {
  const w = await world()
  assertEquals(await rotateIdentityKey(['--env', 'testing', '--revoke'], w.deps), 0)
  assert(w.output.some((line) => line.includes('/admin/access/panel-identity?revoke=')))
})

test('nothing is put without two marked passkeys, an approval or a valid env', async () => {
  for (const [opts, argv] of [
    [{ passkeys: 1 }, ['--env', 'testing']],
    [{ approve: false }, ['--env', 'testing']],
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
