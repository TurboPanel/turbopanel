import { assert, assertEquals, assertRejects } from '@std/assert'
import { parseHelloNonceFrame } from '../contracts/cell-protocol.ts'
import { splitSignature } from '../lib/panel-identity/frame-envelope.ts'
import {
  type PanelIdentity,
  resolvePanelIdentityFromBinding,
} from '../lib/panel-identity/identity.ts'
import { newSignedSession } from '../lib/panel-identity/signed-session.ts'
import { fixtureBindingJson } from '../test-fixtures/panel-identity-fixture.ts'
import { createDaemonSessionSender, decideFirstFrame } from './signed-session-gate.ts'

const test = Deno.test.bind(Deno)

const NONCE = 'b'.repeat(43)
const NONCE_FRAME = JSON.stringify({ type: 'hello-nonce', nonce: NONCE })

const BOUND_NONCE_FRAME = JSON.stringify({
  type: 'hello-nonce',
  nonce: NONCE,
  features: ['panel-bound-session-v1'],
})
const BINDING = { serverId: 'server-a', keyId: 'key-a' }

async function identity(): Promise<PanelIdentity> {
  const loaded = await resolvePanelIdentityFromBinding(await fixtureBindingJson())
  assert(loaded)
  return loaded
}

test('hello-nonce parses only with type hello-nonce and a 43-character base64url nonce', () => {
  assertEquals(parseHelloNonceFrame(NONCE_FRAME), { nonce: NONCE, bound: false })
  assertEquals(parseHelloNonceFrame(JSON.stringify({ type: 'hello-nonce', nonce: NONCE, x: 1 })), {
    nonce: NONCE,
    bound: false,
  })
  assertEquals(parseHelloNonceFrame(BOUND_NONCE_FRAME), { nonce: NONCE, bound: true })
  assertEquals(
    parseHelloNonceFrame(JSON.stringify({ type: 'hello-nonce', nonce: NONCE, features: 'x' })),
    { nonce: NONCE, bound: false }
  )
  assertEquals(parseHelloNonceFrame(JSON.stringify({ t: 'hello-nonce', nonce: NONCE })), null)
  assertEquals(parseHelloNonceFrame(JSON.stringify({ type: 'hello-nonce', nonce: 'short' })), null)
  assertEquals(parseHelloNonceFrame(JSON.stringify({ type: 'hello', nonce: NONCE })), null)
  assertEquals(parseHelloNonceFrame('{"type":"hello-nonce"'), null)
  assertEquals(parseHelloNonceFrame(`${NONCE_FRAME}${' '.repeat(600)}`), null)
})

test('a hello-nonce opens a signed session with a fresh session at seq 1', async () => {
  const id = await identity()
  const decision = await decideFirstFrame(NONCE_FRAME, {
    trustLevel: 0,
    panelIdentity: () => Promise.resolve(id),
  })
  assertEquals(decision.kind, 'signed')
  if (decision.kind !== 'signed') return
  assertEquals(decision.nonce, NONCE)
  assertEquals(decision.session.nextSeq, 1)
  assertEquals(decision.session.kid, id.current.kid)
})

test('the session names the server and key only when the daemon offered the binding', async () => {
  const id = await identity()
  const ctx = {
    trustLevel: 0,
    panelIdentity: () => Promise.resolve(id),
    binding: BINDING,
  }
  const offered = await decideFirstFrame(BOUND_NONCE_FRAME, ctx)
  assert(offered.kind === 'signed')
  assertEquals(offered.session.bind, BINDING)
  const plain = await decideFirstFrame(NONCE_FRAME, ctx)
  assert(plain.kind === 'signed')
  assertEquals(plain.session.bind, undefined)
  const noBinding = await decideFirstFrame(BOUND_NONCE_FRAME, { ...ctx, binding: undefined })
  assert(noBinding.kind === 'signed')
  assertEquals(noBinding.session.bind, undefined)
})

test('a hello-nonce with no identity key is refused, at any trust level', async () => {
  for (const panelIdentity of [undefined, () => Promise.resolve(null)]) {
    assertEquals(await decideFirstFrame(NONCE_FRAME, { trustLevel: 0, panelIdentity }), {
      kind: 'refused',
      reason: 'panel-identity-unavailable',
    })
  }
})

test('any other first frame is unsigned until the server has used signed mode', async () => {
  const hello = JSON.stringify({ type: 'hello', at: '2026-11-02T00:00:00.000Z' })
  let identityReads = 0
  const panelIdentity = () => {
    identityReads += 1
    return Promise.resolve(null)
  }
  assertEquals(await decideFirstFrame(hello, { trustLevel: 0, panelIdentity }), { kind: 'legacy' })
  assertEquals(await decideFirstFrame('{"type":"ping"}', { trustLevel: 0, panelIdentity }), {
    kind: 'legacy',
  })
  assertEquals(await decideFirstFrame(hello, { trustLevel: 1, panelIdentity }), {
    kind: 'refused',
    reason: 'signed-mode-required',
  })
  assertEquals(identityReads, 0)
})

test('an unsigned sender writes plain JSON', async () => {
  const sent: string[] = []
  const sender = createDaemonSessionSender({
    sendText: (text) => sent.push(text),
    onSignedSendFailure: () => {},
  })
  await sender.send({ type: 'version' })
  assertEquals(sent, ['{"type":"version"}'])
})

test('a signed sender numbers frames in call order even when sends overlap', async () => {
  const id = await identity()
  const sent: string[] = []
  const sender = createDaemonSessionSender({
    sendText: (text) => sent.push(text),
    onSignedSendFailure: () => {},
    now: () => Date.parse('2026-11-02T12:00:00.000Z'),
  })
  sender.enterSigned(id, newSignedSession(id.current.kid))
  await Promise.all([
    sender.send({ type: 'version' }),
    sender.send({ type: 'echo' }),
    sender.send({ type: 'command-ack' }),
  ])
  const bodies = sent.map((raw) => JSON.parse(splitSignature(raw)!.unsigned))
  assertEquals(
    bodies.map((b) => [b.type, b.seq]),
    [
      ['version', 1],
      ['echo', 2],
      ['command-ack', 3],
    ]
  )
})

test('a failed signed send reports the failure, and the next send still goes out after it', async () => {
  const id = await identity()
  let failures = 0
  let fail = true
  const sent: string[] = []
  const sender = createDaemonSessionSender({
    sendText: (text) => {
      if (fail) {
        fail = false
        throw new Error('socket closed')
      }
      sent.push(text)
    },
    onSignedSendFailure: () => {
      failures += 1
    },
  })
  sender.enterSigned(id, newSignedSession(id.current.kid))
  await assertRejects(() => sender.send({ type: 'version' }))
  assertEquals(failures, 1)
  await sender.send({ type: 'echo' })
  assertEquals(JSON.parse(splitSignature(sent[0]!)!.unsigned).seq, 2)
})
