import { assert, assertEquals, assertThrows } from '@std/assert'
import { FIXTURE_ED25519_PUBLIC_HEX } from '../../test-fixtures/panel-identity-fixture.ts'
import { fingerprintRawPublicKey, isPanelFingerprint, rawPublicKeyFromJwkX } from './fingerprint.ts'

const test = Deno.test.bind(Deno)

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from((hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)))
}

async function independentFingerprint(raw: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource))
  return btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

test('fingerprint of the RFC 8032 vector public key is 43 base64url characters of its SHA-256', async () => {
  const fp = await fingerprintRawPublicKey(fromHex(FIXTURE_ED25519_PUBLIC_HEX))
  assertEquals(fp.length, 43)
  assert(isPanelFingerprint(fp))
  assertEquals(fp, await independentFingerprint(fromHex(FIXTURE_ED25519_PUBLIC_HEX)))
})

test('isPanelFingerprint refuses wrong lengths and non-base64url characters', () => {
  const ok = 'A'.repeat(43)
  assert(isPanelFingerprint(ok))
  assert(!isPanelFingerprint('A'.repeat(42)))
  assert(!isPanelFingerprint('A'.repeat(44)))
  assert(!isPanelFingerprint(`${'A'.repeat(42)}+`))
  assert(!isPanelFingerprint(`${'A'.repeat(42)}/`))
  assert(!isPanelFingerprint(`${'A'.repeat(42)}=`))
})

test('rawPublicKeyFromJwkX requires exactly 32 bytes', () => {
  assertEquals(rawPublicKeyFromJwkX('A'.repeat(43)).length, 32)
  assertThrows(() => rawPublicKeyFromJwkX('AAAA'), TypeError)
  assertThrows(() => rawPublicKeyFromJwkX(undefined), TypeError)
})
