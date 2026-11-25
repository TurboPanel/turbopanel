import { argon2idAsync } from '@noble/hashes/argon2.js'
import { constantTimeEqualBytes } from './constant-time.ts'

const SMOKE_KEY_BYTES = 32
const SMOKE_EXPECTED_HEX = '0b0ec46824f8586d7949ddb347b46699d76977dedeebfc8999b0cbc0ef764841'

/**
 * Cheap load check for the isolate cold path (Workers): proves the Argon2id
 * library loaded and derives a stable digest, at the smallest parameters the
 * library accepts (m=8 KiB, t=1, p=1). It shares no state with `password.ts`
 * and never produces a stored hash, so it cannot affect the effective policy
 * or any real password hash. `assertPasswordHasherAvailable` (full hash and
 * verify at the real work factor) stays the Deno boot check.
 */
export async function assertPasswordHasherLoadable(): Promise<void> {
  const salt = new Uint8Array(16).fill(7)
  const derive = () =>
    argon2idAsync('turbopanel-argon2id-smoke', salt, {
      m: 8,
      t: 1,
      p: 1,
      dkLen: SMOKE_KEY_BYTES,
      version: 0x13,
    })
  const first = await derive()
  const second = await derive()
  // Fixed known answer at these parameters: a build that is consistent but
  // wrong (a broken or swapped implementation) is caught here.
  if (
    first.length !== SMOKE_KEY_BYTES ||
    !constantTimeEqualBytes(first, second) ||
    hexOf(first) !== SMOKE_EXPECTED_HEX
  ) {
    throw new Error('Argon2id password hasher smoke test failed')
  }
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
