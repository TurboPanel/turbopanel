import { assertEquals, assertRejects } from 'jsr:@std/assert'
import {
  buildJwksDocument,
  deriveDaemonJwtKeyring,
} from './daemon-jwt-keyring.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('deriveDaemonJwtKeyring throws when versioned secrets are empty', async () => {
  await assertRejects(
    () => deriveDaemonJwtKeyring({ versioned: [] }),
    Error,
    'No signing secret available',
  )
})

test('deriveDaemonJwtKeyring exposes active kid and verifiers for each version', async () => {
  const keyring = await deriveDaemonJwtKeyring({
    versioned: [
      { version: 2, value: 'rotation_secret_v2' },
      { version: 1, value: 'rotation_secret_v1' },
    ],
  })

  assertEquals(keyring.active.kid.length > 0, true)
  assertEquals(keyring.verifiers.has(keyring.active.kid), true)
  assertEquals(keyring.publicJwks.length, 2)
  for (const jwk of keyring.publicJwks) {
    assertEquals(jwk.kty, 'OKP')
    assertEquals(jwk.crv, 'Ed25519')
    assertEquals(jwk.use, 'sig')
    assertEquals(jwk.alg, 'EdDSA')
    assertEquals(typeof jwk.kid, 'string')
    assertEquals(keyring.verifiers.has(jwk.kid!), true)
  }
})

test('buildJwksDocument returns public keys only', async () => {
  const keyring = await deriveDaemonJwtKeyring({
    versioned: [{ version: 1, value: 'jwks_test_secret' }],
  })
  const doc = buildJwksDocument(keyring)
  assertEquals(doc.keys, keyring.publicJwks)
  assertEquals(doc.keys[0]?.kid, keyring.active.kid)
})
