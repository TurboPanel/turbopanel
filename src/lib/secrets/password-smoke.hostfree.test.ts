import { assertEquals } from '@std/assert'
import { getArgon2idPolicy } from './password.ts'
import { assertPasswordHasherLoadable } from './password-smoke.ts'

Deno.test('assertPasswordHasherLoadable resolves and leaves the policy alone', async () => {
  const before = getArgon2idPolicy()
  await assertPasswordHasherLoadable()
  assertEquals(getArgon2idPolicy(), before)
})

Deno.test('smoke test pins the known-answer digest', async () => {
  const source = await Deno.readTextFile(new URL('./password-smoke.ts', import.meta.url))
  assertEquals(
    source.includes("'0b0ec46824f8586d7949ddb347b46699d76977dedeebfc8999b0cbc0ef764841'"),
    true
  )
})
