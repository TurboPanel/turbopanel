import { assertEquals } from '@std/assert'
import { getArgon2idPolicy } from './password.ts'
import { assertPasswordHasherLoadable } from './password-smoke.ts'

Deno.test('assertPasswordHasherLoadable resolves and leaves the policy alone', async () => {
  const before = getArgon2idPolicy()
  await assertPasswordHasherLoadable()
  assertEquals(getArgon2idPolicy(), before)
})
