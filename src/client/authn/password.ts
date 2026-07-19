import { argon2idAsync } from '@noble/hashes/argon2.js'
import { compatLogWarn } from '../../log-compat.ts'

/** OWASP 2026 minimum Argon2id baseline (KiB / iterations / parallelism). */
export const ARGON2ID_MEMORY_KIB = 19_456
export const ARGON2ID_ITERATIONS = 2
export const ARGON2ID_PARALLELISM = 1
export const ARGON2ID_VERSION = 0x13

const SALT_BYTES = 16
const KEY_BYTES = 32

/**
 * Upper bounds for stored/verification params (and raise-only configure).
 *
 * Caps keep corrupted PHC strings from requesting unbounded memory or time.
 * 64 MiB stays comfortably under the default 128 MiB Workers isolate limit;
 * iteration/parallelism caps match values @noble/hashes can run without DoS.
 */
const VERIFY_MAX_MEMORY_KIB = 65_536
const VERIFY_MAX_ITERATIONS = 16
const VERIFY_MAX_PARALLELISM = 4

/** Effective policy — raise-only via {@link configureArgon2idWorkFactor}. */
let currentMemoryKib = ARGON2ID_MEMORY_KIB
let currentIterations = ARGON2ID_ITERATIONS

/**
 * Optional raise-only work-factor override (mirrors the old PBKDF2 clamp).
 *
 * Parses each value; absent, invalid, or below the OWASP floor keeps the floor
 * and warns. Only assigns when the parsed value is ≥ the floor — never weakens.
 * Values above the documented verification caps are clamped to the cap.
 */
export function configureArgon2idWorkFactor(opts: {
  memoryKib?: string | null
  timeCost?: string | null
}): void {
  currentMemoryKib = resolveRaiseOnly(
    opts.memoryKib,
    ARGON2ID_MEMORY_KIB,
    VERIFY_MAX_MEMORY_KIB,
    'memoryKiB (m)',
  )
  currentIterations = resolveRaiseOnly(
    opts.timeCost,
    ARGON2ID_ITERATIONS,
    VERIFY_MAX_ITERATIONS,
    'time cost (t)',
  )
}

function resolveRaiseOnly(
  raw: string | null | undefined,
  floor: number,
  ceiling: number,
  label: string,
): number {
  if (raw == null || raw === '') return floor
  const parsed = parsePositiveInt(raw)
  if (parsed === null || parsed < floor) {
    compatLogWarn(
      'auth',
      `Argon2id ${label} invalid or below the minimum (${raw}); using the minimum (${floor}) instead`,
    )
    return floor
  }
  if (parsed > ceiling) {
    compatLogWarn(
      'auth',
      `Argon2id ${label} above the maximum (${raw}); using the maximum (${ceiling}) instead`,
    )
    return ceiling
  }
  return parsed
}

/** Effective Argon2id policy after any raise-only configure. */
export function getArgon2idPolicy(): {
  memoryKib: number
  iterations: number
  parallelism: number
  version: number
} {
  return {
    memoryKib: currentMemoryKib,
    iterations: currentIterations,
    parallelism: ARGON2ID_PARALLELISM,
    version: ARGON2ID_VERSION,
  }
}

/**
 * Boot self-test: hash + verify a sentinel at the current policy.
 * Throws on failure so callers can refuse to start rather than degrade.
 */
export async function assertPasswordHasherAvailable(): Promise<void> {
  const sentinel = 'turbopanel-argon2id-self-test'
  const encoded = await hashPassword(sentinel)
  const ok = await verifyPassword(sentinel, encoded)
  if (!ok) {
    throw new Error('Argon2id password hasher self-test failed')
  }
}

/** Standard Base64 without padding (PHC / Argon2 encoded form). */
function phcBase64Encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary).replaceAll('=', '')
}

function phcBase64Decode(encoded: string): Uint8Array | null {
  if (!encoded || /[^A-Za-z0-9+/]/.test(encoded)) return null
  const padLen = (4 - (encoded.length % 4)) % 4
  try {
    const binary = atob(encoded + '='.repeat(padLen))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.codePointAt(i) ?? 0
    }
    return bytes
  } catch {
    return null
  }
}

type ParsedArgon2id = {
  version: number
  memoryKib: number
  iterations: number
  parallelism: number
  salt: Uint8Array
  digest: Uint8Array
}

/**
 * Full-string positive decimal integer after trimming.
 * Rejects partial parses (`19456junk`, `2.9`, `1foo`) that `Number.parseInt` accepts.
 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return null
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value < 1) return null
  return value
}

/**
 * Whether parsed Argon2id params are within library + documented verification caps.
 * Library requires `m >= 8*p`, `t >= 1`, `1 <= p < 2^24`; we tighten further so
 * corrupted DB rows cannot request unbounded memory or time.
 */
function isSupportedArgon2Params(
  memoryKib: number,
  iterations: number,
  parallelism: number,
): boolean {
  if (
    !Number.isSafeInteger(parallelism) ||
    parallelism < 1 ||
    parallelism > VERIFY_MAX_PARALLELISM
  ) {
    return false
  }
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > VERIFY_MAX_ITERATIONS
  ) {
    return false
  }
  const minMemoryKib = 8 * parallelism
  if (
    !Number.isSafeInteger(memoryKib) ||
    memoryKib < minMemoryKib ||
    memoryKib > VERIFY_MAX_MEMORY_KIB
  ) {
    return false
  }
  return true
}

/** Parse exactly `m`, `t`, and `p` from a PHC param segment (no duplicates/unknowns). */
function parsePhcParamSegment(
  segment: string,
): { memoryKib: number; iterations: number; parallelism: number } | null {
  const tokens = segment.split(',')
  if (tokens.length !== 3) return null

  const params: Record<string, string> = {}
  for (const token of tokens) {
    const eq = token.indexOf('=')
    if (eq <= 0) return null
    const name = token.slice(0, eq)
    if (name !== 'm' && name !== 't' && name !== 'p') return null
    if (Object.hasOwn(params, name)) return null
    params[name] = token.slice(eq + 1)
  }

  const memoryKib = parsePositiveInt(params.m)
  const iterations = parsePositiveInt(params.t)
  const parallelism = parsePositiveInt(params.p)
  if (memoryKib === null || iterations === null || parallelism === null) {
    return null
  }
  if (!isSupportedArgon2Params(memoryKib, iterations, parallelism)) {
    return null
  }
  return { memoryKib, iterations, parallelism }
}

/**
 * Parse a PHC Argon2id string:
 * `$argon2id$v=19$m=<m>,t=<t>,p=<p>$<b64salt>$<b64digest>`
 *
 * Accepts exactly the parameter names `m`, `t`, and `p` (no duplicates/unknowns),
 * a 16-byte salt, and a 32-byte digest.
 */
function parseArgon2idPhc(encoded: string): ParsedArgon2id | null {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'argon2id') {
    return null
  }

  const versionRaw = parts[2]
  if (!versionRaw?.startsWith('v=')) return null
  const version = parsePositiveInt(versionRaw.slice(2))
  if (version !== ARGON2ID_VERSION) return null

  const work = parsePhcParamSegment(parts[3]!)
  if (!work) return null

  const salt = phcBase64Decode(parts[4]!)
  const digest = phcBase64Decode(parts[5]!)
  if (salt?.length !== SALT_BYTES || digest?.length !== KEY_BYTES) {
    return null
  }

  return {
    version,
    memoryKib: work.memoryKib,
    iterations: work.iterations,
    parallelism: work.parallelism,
    salt,
    digest,
  }
}

async function deriveArgon2id(
  password: string,
  salt: Uint8Array,
  memoryKib: number,
  iterations: number,
  parallelism: number,
): Promise<Uint8Array> {
  const normalized = password.normalize('NFKC')
  return await argon2idAsync(normalized, salt, {
    m: memoryKib,
    t: iterations,
    p: parallelism,
    dkLen: KEY_BYTES,
    version: ARGON2ID_VERSION,
  })
}

function constantTimeEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i++) {
    diff |= actual[i]! ^ expected[i]!
  }
  return diff === 0
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const memoryKib = currentMemoryKib
  const iterations = currentIterations
  const digest = await deriveArgon2id(
    password,
    salt,
    memoryKib,
    iterations,
    ARGON2ID_PARALLELISM,
  )
  return (
    `$argon2id$v=${ARGON2ID_VERSION}$m=${memoryKib},t=${iterations},p=${ARGON2ID_PARALLELISM}$` +
    `${phcBase64Encode(salt)}$${phcBase64Encode(digest)}`
  )
}

/**
 * Verify a password against a stored Argon2id PHC string.
 *
 * Derives the candidate digest as bytes and compares with XOR-accumulation
 * constant-time equality. Does **not** delegate final equality to library
 * verify helpers (e.g. `argon2Verify`). Malformed encodings and derivation
 * errors fail closed (`false`) rather than throwing.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parseArgon2idPhc(encoded)
  if (!parsed) return false

  let actual: Uint8Array
  try {
    actual = await deriveArgon2id(
      password,
      parsed.salt,
      parsed.memoryKib,
      parsed.iterations,
      parsed.parallelism,
    )
  } catch {
    return false
  }
  return constantTimeEqual(actual, parsed.digest)
}
