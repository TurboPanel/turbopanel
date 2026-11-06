import { assert, assertEquals } from '@std/assert'
import { sealToRecipient } from '../lib/panel-identity/hpke.ts'
import type { PanelIdentity } from '../lib/panel-identity/identity.ts'
import { importEd25519Signer, importX25519Sealer } from '../lib/panel-identity/keys.ts'
import {
  FIXTURE_ED25519_SEED,
  FIXTURE_X25519_SEED,
} from '../test-fixtures/panel-identity-fixture.ts'
import { resolveIssuedPrivateKey } from './issued-private-key.ts'

const test = Deno.test.bind(Deno)

const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'

async function identity(): Promise<PanelIdentity> {
  return {
    keyset: 1,
    current: await importEd25519Signer(FIXTURE_ED25519_SEED),
    next: null,
    seal: await importX25519Sealer(FIXTURE_X25519_SEED),
  }
}

async function sealedFor(id: PanelIdentity, aad: string) {
  return await sealToRecipient(
    id.seal.publicRaw,
    id.seal.kid,
    aad,
    new TextEncoder().encode(KEY_PEM)
  )
}

test('an envelope sealed to the panel with its identity key id as aad is opened', async () => {
  const id = await identity()
  const envelope = await sealedFor(id, id.current.kid)
  assertEquals(await resolveIssuedPrivateKey({ privateKeyEnvelope: envelope }, id), {
    ok: true,
    privateKeyPem: KEY_PEM,
  })
})

test('plain PEM still works and exactly one of the two fields is required', async () => {
  const id = await identity()
  assertEquals(await resolveIssuedPrivateKey({ privateKeyPem: KEY_PEM }, null), {
    ok: true,
    privateKeyPem: KEY_PEM,
  })
  const both = await resolveIssuedPrivateKey(
    { privateKeyPem: KEY_PEM, privateKeyEnvelope: await sealedFor(id, id.current.kid) },
    id
  )
  assert(!both.ok && both.status === 400)
  const neither = await resolveIssuedPrivateKey({}, id)
  assert(!neither.ok && neither.status === 400)
})

test('a wrong aad, a foreign key id, a bad shape or no identity never opens or echoes the key', async () => {
  const id = await identity()
  const wrongAad = await resolveIssuedPrivateKey(
    { privateKeyEnvelope: await sealedFor(id, 'other') },
    id
  )
  assert(!wrongAad.ok && wrongAad.error === 'envelope_open_failed')
  const foreign = await sealedFor(id, id.current.kid)
  const wrongKid = await resolveIssuedPrivateKey(
    { privateKeyEnvelope: { ...foreign, kid: 'B'.repeat(43) } },
    id
  )
  assert(!wrongKid.ok && wrongKid.error === 'envelope_open_failed')
  const shape = await resolveIssuedPrivateKey({ privateKeyEnvelope: 'tpdaemon.v1.x' }, id)
  assert(!shape.ok && shape.status === 400)
  const none = await resolveIssuedPrivateKey({ privateKeyEnvelope: foreign }, null)
  assert(!none.ok && none.status === 503)
  for (const result of [wrongAad, wrongKid, shape, none]) {
    assert(!JSON.stringify(result).includes('PRIVATE KEY'))
    assert(!JSON.stringify(result).includes(foreign.ct))
  }
})
