import { assert, assertEquals } from '@std/assert'
import { sealToRecipient } from '../../lib/panel-identity/hpke.ts'
import type { PanelIdentity } from '../../lib/panel-identity/identity.ts'
import { importEd25519Signer, importX25519Sealer } from '../../lib/panel-identity/keys.ts'
import {
  FIXTURE_ED25519_SEED,
  FIXTURE_X25519_SEED,
} from '../../test-fixtures/panel-identity-fixture.ts'
import { enrollSealAad, openSealedLicenseToken, parseClientNonce } from './sealed-enroll.ts'

const test = Deno.test.bind(Deno)

const TOKEN = 'fixture-license-token'
const BOUND = {
  challengeId: 'challenge-1',
  challengeNonce: 'nonce-1',
  clientNonce: 'AAAAAAAAAAAAAAAAAAAAAAAA',
  publicKeyFingerprint: 'F'.repeat(43),
}

async function identity(): Promise<PanelIdentity> {
  return {
    keyset: 1,
    current: await importEd25519Signer(FIXTURE_ED25519_SEED),
    next: null,
    seal: await importX25519Sealer(FIXTURE_X25519_SEED),
  }
}

async function sealTo(id: PanelIdentity, bound: typeof BOUND, token = TOKEN) {
  return await sealToRecipient(
    id.seal.publicRaw,
    id.seal.kid,
    enrollSealAad({ ...bound, panelFingerprint: id.current.kid }),
    new TextEncoder().encode(token)
  )
}

test('the genuine control plane opens a token sealed to its key and bound to the request', async () => {
  const id = await identity()
  const opened = await openSealedLicenseToken(await sealTo(id, BOUND), id, BOUND)
  assertEquals(opened, { ok: true, licenseToken: TOKEN })
})

test('an impostor without the sealing key cannot open the token or learn it', async () => {
  const id = await identity()
  const envelope = await sealTo(id, BOUND)
  const impostor: PanelIdentity = {
    ...id,
    seal: await importX25519Sealer(new Uint8Array(32).fill(9)),
  }
  const opened = await openSealedLicenseToken(envelope, impostor, BOUND)
  assertEquals(opened.ok, false)
  assert(!JSON.stringify(envelope).includes(TOKEN))
})

test('an envelope does not open for another challenge, nonce or key', async () => {
  const id = await identity()
  const envelope = await sealTo(id, BOUND)
  for (const changed of [
    { ...BOUND, challengeId: 'challenge-2' },
    { ...BOUND, challengeNonce: 'nonce-2' },
    { ...BOUND, clientNonce: 'BBBBBBBBBBBBBBBBBBBBBBBB' },
    { ...BOUND, publicKeyFingerprint: 'E'.repeat(43) },
  ]) {
    assertEquals((await openSealedLicenseToken(envelope, id, changed)).ok, false)
  }
})

test('a malformed envelope, a missing client nonce or no identity is refused', async () => {
  const id = await identity()
  const envelope = await sealTo(id, BOUND)
  assertEquals((await openSealedLicenseToken('plain', id, BOUND)).ok, false)
  assertEquals(
    (await openSealedLicenseToken(envelope, id, { ...BOUND, clientNonce: undefined })).ok,
    false
  )
  assertEquals(await openSealedLicenseToken(envelope, null, BOUND), {
    ok: false,
    status: 503,
    error: 'panel sealing key unavailable',
  })
})

test('an envelope with an oversized ciphertext or a wrong-size key is refused before opening', async () => {
  const id = await identity()
  const envelope = await sealTo(id, BOUND)
  assertEquals(
    (await openSealedLicenseToken({ ...envelope, ct: 'A'.repeat(7000) }, id, BOUND)).ok,
    false
  )
  assertEquals(
    (await openSealedLicenseToken({ ...envelope, enc: 'A'.repeat(60) }, id, BOUND)).ok,
    false
  )
})

test('a client nonce is accepted only in the expected shape', () => {
  assertEquals(parseClientNonce('AAAAAAAAAAAAAAAAAAAAAAAA'), 'AAAAAAAAAAAAAAAAAAAAAAAA')
  assertEquals(parseClientNonce('short'), undefined)
  assertEquals(parseClientNonce('has spaces and a lot of characters!!'), undefined)
  assertEquals(parseClientNonce(42), undefined)
})
