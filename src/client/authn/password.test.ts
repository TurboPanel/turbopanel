import { describe, expect, it } from 'vitest'
import {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  hashPassword,
  verifyPassword,
} from './password.ts'

/**
 * Workers constraint (documented + exercised here under workerd):
 *
 * Argon2id at m=19456 (~19 MiB) stays well under the default 128 MiB isolate
 * limit and verifies comfortably under ~1s (OWASP interactive target). The
 * hasher is pure-JS `@noble/hashes` with no WASM loader, so there is no
 * `nodejs_compat` or native-addon dependency for password hashing.
 *
 * Anti-PBKDF2 / anti-weak-params regression check for the Workers vitest pool
 * (workerd). Deno coverage (floor, NFKC, fail-closed tags) is in
 * `password.deno.test.ts`. Uses vitest rather than `@std/testing/bdd` because
 * BDD registers against `Deno.test` and cannot drive workerd.
 */
function phcWorkParams(encoded: string): { m: number; t: number; p: number } {
  const parts = encoded.split('$')
  const params = Object.fromEntries(
    parts[3]!.split(',').map((token) => {
      const eq = token.indexOf('=')
      return [token.slice(0, eq), token.slice(eq + 1)]
    }),
  )
  return {
    m: Number.parseInt(params.m!, 10),
    t: Number.parseInt(params.t!, 10),
    p: Number.parseInt(params.p!, 10),
  }
}

describe('password hasher (Workers workerd parity)', () => {
  it('round-trips Argon2id at/above the OWASP floor and rejects wrong passwords', async () => {
    const encoded = await hashPassword('correct horse')
    expect(encoded.startsWith('$argon2id$')).toBe(true)

    const params = phcWorkParams(encoded)
    expect(params.m).toBeGreaterThanOrEqual(ARGON2ID_MEMORY_KIB)
    expect(params.t).toBeGreaterThanOrEqual(ARGON2ID_ITERATIONS)
    expect(params.p).toBeGreaterThanOrEqual(ARGON2ID_PARALLELISM)

    expect(await verifyPassword('correct horse', encoded)).toBe(true)
    expect(await verifyPassword('wrong', encoded)).toBe(false)
  })
})
