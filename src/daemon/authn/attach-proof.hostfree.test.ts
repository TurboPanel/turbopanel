import { assertEquals } from '@std/assert'
import { testDaemonKey } from '../../test-fixtures/daemon-signing-key.test.support.ts'
import { attachSigningInput, decideAttachProof, ed25519PublicJwk } from './attach-proof.ts'

const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-11-05T12:00:00.000Z')
const NOW_S = NOW_MS / 1000
const SESSION = 'session-id-0123456789'
const PANEL = 'P'.repeat(43)
const SERVER = '11111111-2222-4333-8444-555555555555'
const KEY_ID = '7d0a1c3e-5b6f-4a28-9c11-0e2f3a4b5c6d'

async function setup(trustLevel = 0) {
  const key = await testDaemonKey()
  const proof = async (over: { sessionId?: string; iat?: number; keyId?: string } = {}) => {
    const iat = over.iat ?? NOW_S
    const keyId = over.keyId ?? KEY_ID
    const sig = await key.sign(
      attachSigningInput({
        sessionId: over.sessionId ?? SESSION,
        panelFingerprint: PANEL,
        serverId: SERVER,
        keyId,
        iat,
      })
    )
    return { keyId, iat, sig }
  }
  const ctx = {
    sessionId: SESSION,
    panelFingerprint: PANEL,
    serverId: SERVER,
    keyId: KEY_ID,
    publicJwk: key.publicJwk,
    trustLevel,
    nowMs: NOW_MS,
  }
  return { key, proof, ctx }
}

test('the signing input is fixed text', () => {
  assertEquals(
    attachSigningInput({
      sessionId: 's',
      panelFingerprint: 'p',
      serverId: 'v',
      keyId: 'k',
      iat: 9,
    }),
    'tp-attach\ns\np\nv\nk\n9'
  )
})

test('a proof bound to this session verifies', async () => {
  const { proof, ctx } = await setup()
  assertEquals(await decideAttachProof(await proof(), ctx), { kind: 'verified' })
})

test('the key from the cell attachment (x only) verifies too', async () => {
  const { key, proof, ctx } = await setup()
  const publicJwk = ed25519PublicJwk(String(key.publicJwk.x))
  assertEquals(await decideAttachProof(await proof(), { ...ctx, publicJwk }), {
    kind: 'verified',
  })
})

test('no proof is accepted only before the server proved itself', async () => {
  assertEquals(await decideAttachProof(undefined, (await setup(0)).ctx), { kind: 'absent' })
  assertEquals(await decideAttachProof(undefined, (await setup(1)).ctx), { kind: 'absent' })
  assertEquals((await decideAttachProof(undefined, (await setup(2)).ctx)).kind, 'refused')
})

test('another session, key, clock or a malformed proof is refused', async () => {
  const { proof, ctx } = await setup()
  const refused = [
    await proof({ sessionId: 'another-session' }),
    await proof({ keyId: 'another-key' }),
    await proof({ iat: NOW_S - 301 }),
    { keyId: KEY_ID, iat: NOW_S, sig: 'short' },
    'not an object',
  ]
  for (const attach of refused) {
    assertEquals((await decideAttachProof(attach, ctx)).kind, 'refused')
  }
  const otherKey = (await testDaemonKey()).publicJwk
  assertEquals(
    (await decideAttachProof(await proof(), { ...ctx, publicJwk: otherKey })).kind,
    'refused'
  )
  assertEquals(
    (await decideAttachProof(await proof(), { ...ctx, publicJwk: undefined })).kind,
    'refused'
  )
})
