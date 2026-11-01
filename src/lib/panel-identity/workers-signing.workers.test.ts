import { describe, expect, it } from 'vitest'
import { base64urlEncode } from '../encoding/base64url.ts'
import { importEd25519Signer, importX25519Sealer } from './keys.ts'

// RFC 8032 section 7.1 test vector 1 (secret key and public key).
const ED_SEED = Uint8Array.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
    .match(/../g)!
    .map((h) => Number.parseInt(h, 16))
)
const ED_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('panel identity keys in workerd (spike)', () => {
  it('imports an Ed25519 seed, signs and verifies', async () => {
    const signer = await importEd25519Signer(ED_SEED)
    expect(hex(signer.publicRaw)).toBe(ED_PUBLIC)
    expect(signer.kid).toHaveLength(43)
    const message = new TextEncoder().encode('tp-http\n/x\nbody')
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', signer.privateKey, message))
    expect(sig).toHaveLength(64)
    const verifyKey = await crypto.subtle.importKey(
      'raw',
      signer.publicRaw as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify']
    )
    expect(await crypto.subtle.verify('Ed25519', verifyKey, sig, message)).toBe(true)
    const bad = new Uint8Array(sig)
    bad[0] = bad[0]! ^ 1
    expect(await crypto.subtle.verify('Ed25519', verifyKey, bad, message)).toBe(false)
  })

  it('does not let the private key be exported', async () => {
    const signer = await importEd25519Signer(ED_SEED)
    await expect(crypto.subtle.exportKey('jwk', signer.privateKey)).rejects.toThrow()
  })

  it('imports an X25519 seed and agrees on a shared secret', async () => {
    const a = await importX25519Sealer(new Uint8Array(32).fill(7))
    const b = await importX25519Sealer(new Uint8Array(32).fill(9))
    const pubB = await crypto.subtle.importKey(
      'raw',
      b.publicRaw as BufferSource,
      { name: 'X25519' },
      false,
      []
    )
    const pubA = await crypto.subtle.importKey(
      'raw',
      a.publicRaw as BufferSource,
      { name: 'X25519' },
      false,
      []
    )
    const ab = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'X25519', public: pubB }, a.privateKey, 256)
    )
    const ba = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'X25519', public: pubA }, b.privateKey, 256)
    )
    expect(base64urlEncode(ab)).toBe(base64urlEncode(ba))
  })
})
