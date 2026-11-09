import { assert, assertEquals, assertThrows } from '@std/assert'
import { fixtureBindingJson } from '../../test-fixtures/panel-identity-fixture.ts'
import { base64urlDecode } from '../encoding/base64url.ts'
import {
  appendSignature,
  frameSigningInput,
  helloSigningInput,
  httpSigningInput,
  splitSignature,
} from './frame-envelope.ts'
import { resolvePanelIdentityFromBinding, type PanelIdentity } from './identity.ts'
import { buildSignedHello, envelopeFrame, newSignedSession } from './signed-session.ts'

const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-11-02T12:00:00.000Z')
const NONCE = 'a'.repeat(43)
const decoder = new TextDecoder()

async function identity(): Promise<PanelIdentity> {
  const loaded = await resolvePanelIdentityFromBinding(await fixtureBindingJson())
  assert(loaded)
  return loaded
}

async function verifies(id: PanelIdentity, input: Uint8Array, sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    id.current.publicRaw as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify']
  )
  return await crypto.subtle.verify(
    'Ed25519',
    key,
    base64urlDecode(sig) as BufferSource,
    input as BufferSource
  )
}

test('the signature goes in as the last member and splits back to the exact signed bytes', () => {
  const unsigned = JSON.stringify({ type: 'x', note: 'contains ,"sig":"fake" inside' })
  const wire = appendSignature(unsigned, 'c2ln')
  assertEquals(wire.endsWith(',"sig":"c2ln"}'), true)
  assertEquals(splitSignature(wire), { unsigned, sig: 'c2ln' })
  assertEquals(JSON.parse(wire).sig, 'c2ln')
})

test('a frame with no trailing signature, or a signature that is not base64url, does not split', () => {
  assertEquals(splitSignature('{"type":"version"}'), null)
  assertEquals(splitSignature('{"sig":"abc"}'), null)
  assertEquals(splitSignature('{"type":"x","sig":"a+b"}'), null)
  assertEquals(splitSignature('{"type":"x","sig":"abc"} '), null)
  assertThrows(() => appendSignature('[]', 'c2ln'), TypeError)
})

test('signing inputs carry the per-kind prefix', () => {
  assertEquals(decoder.decode(helloSigningInput('{}')), 'tp-hello\n{}')
  assertEquals(decoder.decode(frameSigningInput('version', '{}')), 'tp-frame\nversion\n{}')
  assertEquals(decoder.decode(httpSigningInput('/p', 'b')), 'tp-http\n/p\nb')
})

test('the hello echoes the nonce, names the key and verifies over tp-hello plus its exact bytes', async () => {
  const id = await identity()
  const session = newSignedSession(id.current.kid)
  const raw = await buildSignedHello(id, NONCE, session, {
    heartbeatSeconds: 45,
    urls: ['https://a.example.test'],
    nowMs: NOW_MS,
  })
  const split = splitSignature(raw)
  assert(split)
  assertEquals(await verifies(id, helloSigningInput(split.unsigned), split.sig), true)
  assertEquals(JSON.parse(split.unsigned), {
    type: 'hello',
    nonce: NONCE,
    sessionId: session.sessionId,
    kid: id.current.kid,
    keyset: id.keyset,
    heartbeatSeconds: 45,
    urls: ['https://a.example.test'],
    iat: NOW_MS / 1000,
  })
})

test('an enveloped frame keeps the message, appends the envelope and verifies over its type', async () => {
  const id = await identity()
  const session = newSignedSession(id.current.kid)
  const wire: { type: string; features: string[] } = { type: 'version', features: ['a'] }
  const raw = await envelopeFrame(id, session, wire, 7, NOW_MS)
  const split = splitSignature(raw)
  assert(split)
  assertEquals(await verifies(id, frameSigningInput('version', split.unsigned), split.sig), true)
  assertEquals(await verifies(id, frameSigningInput('pong', split.unsigned), split.sig), false)
  assertEquals(JSON.parse(split.unsigned), {
    type: 'version',
    features: ['a'],
    sessionId: session.sessionId,
    seq: 7,
    iat: NOW_MS / 1000,
    kid: id.current.kid,
  })
  assertEquals(session.nextSeq, 1)
})

test('a bound hello and frame carry the server and key inside the signed bytes', async () => {
  const id = await identity()
  const bind = { serverId: 'server-a', keyId: 'key-a' }
  const session = newSignedSession(id.current.kid, bind)
  const hello = splitSignature(
    await buildSignedHello(id, NONCE, session, { heartbeatSeconds: 45, urls: [], nowMs: NOW_MS })
  )
  assert(hello)
  assertEquals(await verifies(id, helloSigningInput(hello.unsigned), hello.sig), true)
  const helloBody = JSON.parse(hello.unsigned)
  assertEquals([helloBody.forServer, helloBody.forKey], ['server-a', 'key-a'])
  assertEquals(
    Object.keys(helloBody),
    ['type', 'nonce', 'sessionId', 'kid', 'forServer', 'forKey', 'keyset'].concat(
      'heartbeatSeconds',
      'urls',
      'iat'
    )
  )
  const frame = splitSignature(await envelopeFrame(id, session, { type: 'version' }, 1, NOW_MS))
  assert(frame)
  assertEquals(await verifies(id, frameSigningInput('version', frame.unsigned), frame.sig), true)
  const body = JSON.parse(frame.unsigned)
  assertEquals([body.forServer, body.forKey], ['server-a', 'key-a'])
  // The members are inside the signed bytes: another server's text does not verify.
  const swapped = frame.unsigned.replace('server-a', 'server-v')
  assertEquals(await verifies(id, frameSigningInput('version', swapped), frame.sig), false)
})

test('a message that already uses an envelope member is refused, not overwritten', async () => {
  const id = await identity()
  const session = newSignedSession(id.current.kid)
  for (const field of ['sessionId', 'seq', 'iat', 'kid', 'forServer', 'forKey', 'sig']) {
    let threw = false
    try {
      await envelopeFrame(id, session, { type: 'x', [field]: 1 } as { type: string }, 1, NOW_MS)
    } catch (err) {
      threw = err instanceof TypeError
    }
    assertEquals(threw, true, field)
  }
})

test('session ids are 16 random bytes in base64url', () => {
  const a = newSignedSession('k')
  assertEquals(/^[A-Za-z0-9_-]{22}$/.test(a.sessionId), true)
  assertEquals(a.nextSeq, 1)
})
