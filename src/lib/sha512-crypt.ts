/**
 * sha512-crypt (`$6$`) — the `crypt(3)` scheme Linux PAM verifies against
 * `/etc/shadow`.
 *
 * This exists for **system principal** password sign-in: the daemon writes the
 * hash to the host with `chpasswd -e`, so the format has to be one the host's
 * libcrypt verifies natively. That rules out the Argon2id used for credential
 * accounts (`client/authn/password.ts`) — PAM does not speak PHC Argon2 — and
 * is why this module implements Ulrich Drepper's sha512-crypt instead: it is
 * the strongest scheme every supported host verifies. The plaintext never
 * leaves the control plane; only this hash rides the command rail, which also
 * means a command-record leak exposes at worst an offline-crackable hash,
 * exactly the exposure `/etc/shadow` itself has.
 *
 * Implemented against the reference specification and pinned by its published
 * test vectors in `sha512-crypt.test.ts`. Do not "simplify" the digest
 * shuffle or the alternate-sum loops — every odd-looking step is normative,
 * and a hash that is almost right verifies never.
 */

import { sha512 } from '@noble/hashes/sha2.js'

/** Shadow-safe salt alphabet — also the output digest alphabet. */
const CRYPT_B64 =
  './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * Work factor for new hashes. Explicit rather than the scheme's default 5000:
 * verification runs in the host's C libcrypt where 100k rounds is a few
 * milliseconds, while offline cracking pays it per guess. Hashing here is
 * one-time per password set.
 */
export const SHA512_CRYPT_ROUNDS = 100000

const MIN_ROUNDS = 1000
const MAX_ROUNDS = 999999999
const SALT_LENGTH = 16

/**
 * Shape of every hash this module emits (and the only shape the daemon
 * accepts). Keep in sync with `PASSWORD_HASH_RE` in the daemon's
 * `deploy/ensure-principal.ts` and its wire gate in
 * `instance/commands/contracts.ts`.
 */
export const SHA512_CRYPT_HASH_RE =
  /^\$6\$(?:rounds=\d{4,9}\$)?[./0-9A-Za-z]{8,16}\$[./0-9A-Za-z]{86}$/

const encoder = new TextEncoder()

/** Concatenate byte chunks. */
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** `source` repeated/truncated to exactly `length` bytes. */
function repeatTo(source: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = source[i % source.length]
  return out
}

/** Little-endian 6-bit groups, the crypt(3) encoding (not RFC 4648). */
function b64From24Bit(
  b2: number,
  b1: number,
  b0: number,
  chars: number,
): string {
  let w = (b2 << 16) | (b1 << 8) | b0
  let out = ''
  for (let i = 0; i < chars; i++) {
    out += CRYPT_B64[w & 0x3f]
    w >>>= 6
  }
  return out
}

/**
 * The normative byte shuffle: digest bytes are emitted in this exact
 * interleaved order, three at a time, with a two-character tail for byte 63.
 */
const OUTPUT_ORDER: ReadonlyArray<readonly [number, number, number]> = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4],
  [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51],
  [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35],
  [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19],
  [62, 20, 41],
]

function encodeDigest(digest: Uint8Array): string {
  let out = ''
  for (const [a, b, c] of OUTPUT_ORDER) {
    out += b64From24Bit(digest[a], digest[b], digest[c], 4)
  }
  out += b64From24Bit(0, 0, digest[63], 2)
  return out
}

/**
 * Core key-derivation from the specification. `password` and `salt` are the
 * raw bytes; `rounds` is already clamped by the caller.
 */
function sha512CryptDigest(
  password: Uint8Array,
  salt: Uint8Array,
  rounds: number,
): Uint8Array {
  // Digest B: password + salt + password.
  const digestB = sha512(concat([password, salt, password]))

  // Digest A: password + salt + (B truncated/repeated to password length),
  // then one of B/password per bit of the password length, low bit first.
  const aParts: Uint8Array[] = [
    password,
    salt,
    repeatTo(digestB, password.length),
  ]
  for (let cnt = password.length; cnt > 0; cnt >>= 1) {
    aParts.push((cnt & 1) !== 0 ? digestB : password)
  }
  const digestA = sha512(concat(aParts))

  // P: from a digest of the password repeated password-length times.
  const dpParts: Uint8Array[] = new Array(password.length).fill(password)
  const p = repeatTo(sha512(concat(dpParts)), password.length)

  // S: from a digest of the salt repeated (16 + A[0]) times.
  const dsParts: Uint8Array[] = []
  for (let i = 0; i < 16 + digestA[0]; i++) dsParts.push(salt)
  const s = repeatTo(sha512(concat(dsParts)), salt.length)

  // The rounds loop, alternating inputs by round parity and the 3/7 skips.
  let c = digestA
  for (let i = 0; i < rounds; i++) {
    const parts: Uint8Array[] = []
    parts.push((i & 1) !== 0 ? p : c)
    if (i % 3 !== 0) parts.push(s)
    if (i % 7 !== 0) parts.push(p)
    parts.push((i & 1) !== 0 ? c : p)
    c = sha512(concat(parts))
  }
  return c
}

/**
 * Parse a `$6$[rounds=N$]salt` prefix (a full hash is fine too — anything
 * after the salt's `$` is ignored, which is what lets a verifier reuse this).
 */
function parseSaltString(
  saltString: string,
): { rounds: number; roundsExplicit: boolean; salt: string } {
  if (!saltString.startsWith('$6$')) {
    throw new TypeError('sha512-crypt salt must start with $6$')
  }
  let rest = saltString.slice(3)
  let rounds = 5000
  let roundsExplicit = false
  const roundsMatch = /^rounds=(\d{1,10})\$/.exec(rest)
  if (roundsMatch) {
    roundsExplicit = true
    rounds = Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Number(roundsMatch[1])))
    rest = rest.slice(roundsMatch[0].length)
  }
  const salt = rest.split('$')[0].slice(0, SALT_LENGTH)
  if (salt.length === 0) {
    throw new TypeError('sha512-crypt salt must not be empty')
  }
  return { rounds, roundsExplicit, salt }
}

/**
 * `crypt(password, "$6$[rounds=N$]salt")` — exposed with the classic shape so
 * the reference test vectors pin the implementation byte-for-byte.
 */
export function sha512Crypt(password: string, saltString: string): string {
  const { rounds, roundsExplicit, salt } = parseSaltString(saltString)
  const digest = sha512CryptDigest(
    encoder.encode(password),
    encoder.encode(salt),
    rounds,
  )
  const prefix = roundsExplicit ? `$6$rounds=${rounds}$` : '$6$'
  return `${prefix}${salt}$${encodeDigest(digest)}`
}

/**
 * Hash a new principal password: fresh random 16-char salt,
 * {@link SHA512_CRYPT_ROUNDS} rounds. The one entry point the password routes
 * use.
 */
export function hashPrincipalPassword(password: string): string {
  const saltBytes = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(saltBytes)
  let salt = ''
  for (const byte of saltBytes) salt += CRYPT_B64[byte & 0x3f]
  return sha512Crypt(password, `$6$rounds=${SHA512_CRYPT_ROUNDS}$${salt}`)
}
