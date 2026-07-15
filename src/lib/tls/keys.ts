/**
 * Private key ↔ certificate public-key matching via Web Crypto sign/verify.
 */

import { decodePrivateKeyToPkcs8, PemError } from './pem.ts'
import type { ParsedCertificate } from './types.ts'

export class TlsKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TlsKeyError'
  }
}

function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

/**
 * Returns true when the private key PEM matches the leaf certificate SPKI.
 * Proves possession by signing a challenge and verifying with the cert public key.
 */
export async function privateKeyMatchesCertificate(
  privateKeyPem: string,
  parsed: ParsedCertificate,
): Promise<boolean> {
  let decoded: { pkcs8: Uint8Array; algorithm: 'rsa' | 'ec' | 'okp' }
  try {
    decoded = decodePrivateKeyToPkcs8(privateKeyPem)
  } catch (err) {
    if (err instanceof PemError) {
      throw new TlsKeyError(err.message)
    }
    throw err
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const pkcs8 = asBufferSource(decoded.pkcs8)
  const spki = asBufferSource(parsed.spkiDer)

  try {
    if (decoded.algorithm === 'rsa') {
      const algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const
      const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8,
        algo,
        false,
        ['sign'],
      )
      const publicKey = await crypto.subtle.importKey(
        'spki',
        spki,
        algo,
        false,
        ['verify'],
      )
      const signature = await crypto.subtle.sign(algo, privateKey, challenge)
      return await crypto.subtle.verify(algo, publicKey, signature, challenge)
    }

    if (decoded.algorithm === 'ec') {
      for (const namedCurve of ['P-256', 'P-384', 'P-521'] as const) {
        try {
          const algo = { name: 'ECDSA', namedCurve } as const
          const privateKey = await crypto.subtle.importKey(
            'pkcs8',
            pkcs8,
            algo,
            false,
            ['sign'],
          )
          const publicKey = await crypto.subtle.importKey(
            'spki',
            spki,
            algo,
            false,
            ['verify'],
          )
          const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            privateKey,
            challenge,
          )
          return await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            publicKey,
            signature,
            challenge,
          )
        } catch {
          // try next curve
        }
      }
      throw new TlsKeyError('failed to import EC private key')
    }

    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    const publicKey = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    const signature = await crypto.subtle.sign('Ed25519', privateKey, challenge)
    return await crypto.subtle.verify('Ed25519', publicKey, signature, challenge)
  } catch (err) {
    if (err instanceof TlsKeyError) throw err
    throw new TlsKeyError(
      err instanceof Error
        ? `failed to match private key: ${err.message}`
        : 'failed to match private key',
    )
  }
}
