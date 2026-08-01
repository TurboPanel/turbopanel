#!/usr/bin/env node
/**
 * Generate TurboPanel secrets/passwords (48 chars, [A-Za-z0-9_], ≥1 underscore in pos 2–47).
 * Runtime import: src/generate-secret.ts re-exports this module.
 */

const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)

/** Allowed characters for generated secrets — not a credential. */
export const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'

export const SECRET_LENGTH = 48

const WITHOUT_UNDERSCORE = ALPHABET.slice(0, -1)

function rejectionLimit(alphabetLength) {
  return Math.floor(256 / alphabetLength) * alphabetLength
}

function randomInt(n) {
  const limit = rejectionLimit(n)
  while (true) {
    const bytes = new Uint8Array(1)
    getRandomValues(bytes)
    const byte = bytes[0]
    if (byte < limit) return byte % n
  }
}

function randomIndex(alphabet) {
  return randomInt(alphabet.length)
}

function randomChar(alphabet) {
  return alphabet[randomIndex(alphabet)]
}

function randomChars(alphabet, count) {
  let result = ''
  const limit = rejectionLimit(alphabet.length)

  while (result.length < count) {
    const bytes = new Uint8Array(64)
    getRandomValues(bytes)

    for (const byte of bytes) {
      if (byte >= limit) continue
      result += alphabet[byte % alphabet.length]
      if (result.length === count) break
    }
  }

  return result
}

function middleHasUnderscore(secret) {
  for (let i = 1; i < SECRET_LENGTH - 1; i++) {
    if (secret[i] === '_') return true
  }
  return false
}

function ensureMiddleUnderscore(chars) {
  if (middleHasUnderscore(chars.join(''))) return
  const pos = 1 + randomInt(46)
  chars[pos] = '_'
}

export function generateSecret() {
  const chars = randomChars(ALPHABET, SECRET_LENGTH).split('')

  if (chars[0] === '_') chars[0] = randomChar(WITHOUT_UNDERSCORE)
  if (chars[SECRET_LENGTH - 1] === '_') {
    chars[SECRET_LENGTH - 1] = randomChar(WITHOUT_UNDERSCORE)
  }

  ensureMiddleUnderscore(chars)
  return chars.join('')
}

export const generatePassword = generateSecret

const isMain =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  process.argv[1].endsWith('generate-secret.mjs')
if (isMain) {
  const count = Math.max(1, Number.parseInt(process.argv[2] ?? '1', 10) || 1)
  for (let i = 0; i < count; i++) {
    console.log(generateSecret())
  }
}
