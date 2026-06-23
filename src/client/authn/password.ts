export const DEFAULT_PBKDF2_ITERATIONS = 600_000

const SALT_BYTES = 16
const KEY_BYTES = 32

let hashIterations = DEFAULT_PBKDF2_ITERATIONS

/** Apply `TURBOPANEL_PBKDF2_ITERATIONS` at runtime boot (Workers env binding or Deno env). */
export function configurePbkdf2Iterations(raw?: string | null): void {
  const trimmed = raw?.trim()
  if (!trimmed) {
    hashIterations = DEFAULT_PBKDF2_ITERATIONS
    return
  }
  const parsed = Number.parseInt(trimmed, 10)
  hashIterations = Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_PBKDF2_ITERATIONS
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function base64urlDecode(encoded: string): Uint8Array | null {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  try {
    const binary = atob(padded + '='.repeat(padLen))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
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
  if (!salt || !expected || expected.length !== KEY_BYTES) {
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
