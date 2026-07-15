import { compatLogWarn } from '../../log-compat.ts'

export const DEFAULT_PBKDF2_ITERATIONS = 600_000

/**
 * Hard floor for PBKDF2 iterations used when hashing **new** passwords and
 * license tokens. `TURBOPANEL_PBKDF2_ITERATIONS` may only raise the work factor
 * above this minimum — lower, invalid, or missing values are ignored (with a
 * warning) so a misconfiguration can never weaken freshly generated hashes.
 */
export const MIN_PBKDF2_ITERATIONS = DEFAULT_PBKDF2_ITERATIONS

const SALT_BYTES = 16
const KEY_BYTES = 32

let hashIterations = DEFAULT_PBKDF2_ITERATIONS

/** Apply `TURBOPANEL_PBKDF2_ITERATIONS` at runtime boot (Workers env binding or Deno env). */
export function configurePbkdf2Iterations(raw?: string | null): void {
  const trimmed = raw?.trim()
  if (!trimmed) {
    hashIterations = MIN_PBKDF2_ITERATIONS
    return
  }
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed < MIN_PBKDF2_ITERATIONS) {
    compatLogWarn(
      'auth',
      `TURBOPANEL_PBKDF2_ITERATIONS="${trimmed}" is below the minimum ${MIN_PBKDF2_ITERATIONS} — using the minimum instead`,
    )
    hashIterations = MIN_PBKDF2_ITERATIONS
    return
  }
  hashIterations = parsed
}

/** The iteration count applied to newly hashed passwords/license tokens. */
export function currentPbkdf2Iterations(): number {
  return hashIterations
}

/**
 * Rehash-on-login planning: returns true when a stored hash uses fewer
 * iterations than the current policy, so callers may transparently re-hash the
 * password on a successful sign-in. A malformed hash returns false (verify
 * fails independently).
 */
export function passwordNeedsRehash(encoded: string): boolean {
  const parts = encoded.split('$')
  if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') {
    return false
  }
  const iterations = Number.parseInt(parts[2], 10)
  if (!Number.isFinite(iterations) || iterations < 1) {
    return false
  }
  return iterations < hashIterations
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function base64urlDecode(encoded: string): Uint8Array | null {
  const padded = encoded.replaceAll('-', '+').replaceAll('_', '/')
  const padLen = (4 - (padded.length % 4)) % 4
  try {
    const binary = atob(padded + '='.repeat(padLen))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.codePointAt(i) ?? 0
    }
    return bytes
  } catch {
    return null
  }
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer,
      iterations,
    },
    keyMaterial,
    KEY_BYTES * 8,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const key = await deriveKey(password, salt, hashIterations)
  return `$pbkdf2-sha256$${hashIterations}$${base64urlEncode(salt)}$${base64urlEncode(key)}`
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 5 || parts[1] !== 'pbkdf2-sha256') {
    return false
  }

  const iterations = Number.parseInt(parts[2], 10)
  if (!Number.isFinite(iterations) || iterations < 1) {
    return false
  }

  const salt = base64urlDecode(parts[3])
  const expected = base64urlDecode(parts[4])
  if (!salt || expected?.length !== KEY_BYTES) {
    return false
  }

  const actual = await deriveKey(password, salt, iterations)
  if (actual.length !== expected.length) return false

  let diff = 0
  for (let i = 0; i < actual.length; i++) {
    diff |= actual[i] ^ expected[i]
  }
  return diff === 0
}
