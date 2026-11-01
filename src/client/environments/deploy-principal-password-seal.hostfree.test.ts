import { assertEquals } from '@std/assert'
import { sealPrincipalPasswordHashes } from './deploy-principal-password-seal.ts'

const test = Deno.test.bind(Deno)

const HASH = `$6$saltstring$${'a'.repeat(86)}`

test('password hashes become envelopes and entries without a hash pass through', async () => {
  const sealed = await sealPrincipalPasswordHashes(
    [
      { principalId: 'p1', username: 'alice', passwordHash: HASH },
      { principalId: 'p2', username: 'bob' },
    ],
    (plaintext) => Promise.resolve(`tpdaemon.v1.sealed-${plaintext.length}`)
  )
  assertEquals(sealed[0], {
    principalId: 'p1',
    username: 'alice',
    passwordHashEnvelope: `tpdaemon.v1.sealed-${HASH.length}`,
  })
  assertEquals('passwordHash' in sealed[0], false)
  assertEquals(sealed[1], { principalId: 'p2', username: 'bob' })
})
