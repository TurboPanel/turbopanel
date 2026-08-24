/**
 * Ed25519 deploy-key generation, in OpenSSH's own formats (Workers-safe).
 *
 * A GitLab source that is **not** connected through OAuth clones with a
 * read-only deploy key. Asking an operator to produce one by hand
 * (`ssh-keygen`, then paste both halves into two different UIs) is where that
 * flow goes wrong — the private half ends up in a chat message, or a key with a
 * passphrase is pasted and every clone hangs on a prompt. So the instance mints
 * the pair: the private half is sealed into a `credential` row and never shown
 * again, the public half is returned once for the operator to paste into
 * GitLab.
 *
 * Two formats, because git needs one and GitLab needs the other:
 *
 * - **Private**: OpenSSH's `-----BEGIN OPENSSH PRIVATE KEY-----` container.
 *   Not PKCS#8 — `ssh` refuses PKCS#8 Ed25519 keys, and the daemon writes this
 *   value straight to a `0600` identity file (`credentialKind: 'ssh_key'`).
 *   Written unencrypted on purpose: a passphrase would have to travel to the
 *   host to be useful, which is strictly worse than the sealed-at-rest envelope
 *   it already lives in.
 * - **Public**: the one-line `ssh-ed25519 AAAA… comment` authorized-keys form.
 *
 * Web Crypto only (`crypto.subtle.generateKey({ name: 'Ed25519' })`), so the
 * module stays reachable from `src/workers.ts`. Ed25519 rather than RSA because
 * both runtimes can generate it natively and neither can generate RSA-SHA2 keys
 * in a form OpenSSH accepts without a bignum library.
 */

const textEncoder = new TextEncoder()

export class SshKeypairError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshKeypairError'
  }
}

export type GeneratedSshKeypair = {
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` block, unencrypted. */
  privateKeyOpenssh: string
  /** `ssh-ed25519 AAAA… <comment>` — the line pasted into the provider. */
  publicKeyOpenssh: string
  /** `SHA256:…` fingerprint, for showing which key a credential holds. */
  fingerprint: string
}

const KEY_TYPE = 'ssh-ed25519'
/** Unencrypted keys use the `none` cipher, whose block size is 8. */
const NONE_CIPHER_BLOCK_SIZE = 8

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, false)
  return out
}

/** SSH wire `string`: a big-endian length followed by the bytes. */
function sshString(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value
  return concatBytes([uint32(bytes.length), bytes])
}

function base64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  return btoa(binary)
}

/** PEM bodies wrap at 70 characters in OpenSSH's writer. */
function wrapBase64(value: string, width = 70): string {
  const lines: string[] = []
  for (let i = 0; i < value.length; i += width) {
    lines.push(value.slice(i, i + width))
  }
  return lines.join('\n')
}

/**
 * Ed25519 PKCS#8 → the raw 32-byte seed.
 *
 * The DER for an Ed25519 private key is fixed-shape
 * (`SEQUENCE { INTEGER 0, SEQUENCE { id-Ed25519 }, OCTET STRING { OCTET STRING
 * seed } }`), 48 bytes total, so the seed is simply the last 32. Same reasoning
 * as `wrapPkcs1AsPkcs8` in `./github-app-token.ts`: a fixed ASN.1 shape needs no
 * parser.
 */
function ed25519SeedFromPkcs8(pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length < 32) {
    throw new SshKeypairError('generated ed25519 private key is malformed')
  }
  return pkcs8.slice(-32)
}

/** `ssh-ed25519` public key blob — the value base64'd into both formats. */
function ed25519PublicBlob(publicKey: Uint8Array): Uint8Array {
  return concatBytes([sshString(KEY_TYPE), sshString(publicKey)])
}

/** `SHA256:<base64 without padding>` over the public blob, as `ssh-keygen -l`. */
async function publicKeyFingerprint(publicBlob: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', publicBlob as BufferSource)
  return `SHA256:${base64Encode(new Uint8Array(digest)).replace(/=+$/, '')}`
}

/**
 * Assemble the `openssh-key-v1` container around one unencrypted Ed25519 key.
 *
 * The layout is OpenSSH's `PROTOCOL.key`: a magic string, the (absent) cipher
 * and KDF, one public blob, then a private section that is padded with the
 * incrementing byte sequence `1, 2, 3, …` to a multiple of the cipher block
 * size.
 */
function encodeOpensshPrivateKey(params: {
  publicKey: Uint8Array
  seed: Uint8Array
  comment: string
}): string {
  const publicBlob = ed25519PublicBlob(params.publicKey)
  // OpenSSH stores the 64-byte libsodium secret key: seed followed by public.
  const secretKey = concatBytes([params.seed, params.publicKey])
  // Two identical check ints; a decrypting reader compares them to detect a
  // wrong passphrase. There is no passphrase here, so any value works — random
  // keeps the encoding identical in shape to a real one.
  const check = crypto.getRandomValues(new Uint8Array(4))

  let privateSection = concatBytes([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(params.publicKey),
    sshString(secretKey),
    sshString(params.comment),
  ])
  const padding = (NONE_CIPHER_BLOCK_SIZE -
    (privateSection.length % NONE_CIPHER_BLOCK_SIZE)) % NONE_CIPHER_BLOCK_SIZE
  if (padding > 0) {
    const pad = new Uint8Array(padding)
    for (let i = 0; i < padding; i += 1) pad[i] = i + 1
    privateSection = concatBytes([privateSection, pad])
  }

  const blob = concatBytes([
    textEncoder.encode('openssh-key-v1\0'),
    sshString('none'), // ciphername
    sshString('none'), // kdfname
    sshString(new Uint8Array(0)), // kdfoptions
    uint32(1), // one key in this file
    sshString(publicBlob),
    sshString(privateSection),
  ])

  return [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    wrapBase64(base64Encode(blob)),
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n')
}

/**
 * Mint one Ed25519 deploy keypair.
 *
 * `comment` is what shows next to the key in the provider's deploy-key list —
 * pass something that identifies this instance and source, because the operator
 * will be looking at it months later trying to work out what may be revoked.
 */
export async function generateSshDeployKeypair(
  comment: string,
): Promise<GeneratedSshKeypair> {
  let pair: CryptoKeyPair
  try {
    pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
  } catch {
    throw new SshKeypairError('this runtime cannot generate ed25519 keys')
  }

  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', pair.privateKey),
  )
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  )
  if (publicKey.length !== 32) {
    throw new SshKeypairError('generated ed25519 public key is malformed')
  }

  const trimmedComment = comment.trim().replaceAll(/\s+/g, '-').slice(0, 120) ||
    'turbopanel'
  const publicBlob = ed25519PublicBlob(publicKey)

  return {
    privateKeyOpenssh: encodeOpensshPrivateKey({
      publicKey,
      seed: ed25519SeedFromPkcs8(pkcs8),
      comment: trimmedComment,
    }),
    publicKeyOpenssh: `${KEY_TYPE} ${base64Encode(publicBlob)} ${trimmedComment}`,
    fingerprint: await publicKeyFingerprint(publicBlob),
  }
}
