import { assert, assertEquals, assertRejects } from '@std/assert'
import {
  FIXTURE_ED25519_PUBLIC_HEX,
  FIXTURE_NEXT_FINGERPRINT,
  fixtureBindingJson,
} from '../../test-fixtures/panel-identity-fixture.ts'
import { fingerprintRawPublicKey } from './fingerprint.ts'
import { resolvePanelIdentityFromBinding } from './identity.ts'

const test = Deno.test.bind(Deno)

test('an unset or blank binding means the feature is off', async () => {
  assertEquals(await resolvePanelIdentityFromBinding(undefined), null)
  assertEquals(await resolvePanelIdentityFromBinding(''), null)
  assertEquals(await resolvePanelIdentityFromBinding('   '), null)
})

test('a valid binding yields kids equal to the fingerprints of the derived public keys', async () => {
  const identity = await resolvePanelIdentityFromBinding(await fixtureBindingJson())
  assert(identity)
  assertEquals(identity.keyset, 1)
  assertEquals(identity.next, null)
  const expected = Uint8Array.from(
    (FIXTURE_ED25519_PUBLIC_HEX.match(/../g) ?? []).map((h) => Number.parseInt(h, 16))
  )
  assertEquals(identity.current.kid, await fingerprintRawPublicKey(expected))
  assertEquals(identity.current.publicRaw, expected)
  assertEquals(identity.seal.publicRaw.length, 32)
})

test('a next fingerprint is carried without a key', async () => {
  const identity = await resolvePanelIdentityFromBinding(
    await fixtureBindingJson({ next: { kid: FIXTURE_NEXT_FINGERPRINT } })
  )
  assertEquals(identity?.next, { kid: FIXTURE_NEXT_FINGERPRINT })
})

test('a malformed binding throws an error naming the binding', async () => {
  const bad = [
    'not json',
    '[]',
    JSON.stringify({ keyset: 1 }),
    await fixtureBindingJson({ keyset: 0 }),
    await fixtureBindingJson({ keyset: 1.5 }),
    await fixtureBindingJson({ currentKid: 'B'.repeat(43) }),
    await fixtureBindingJson({ next: { kid: 'short' } }),
  ]
  for (const raw of bad) {
    const err = await assertRejects(() => resolvePanelIdentityFromBinding(raw), Error)
    assert(err.message.startsWith('TURBOPANEL_IDENTITY_KEYS is malformed: '), err.message)
    assert(!err.message.includes('priv":'), 'error must not echo the value')
  }
})
