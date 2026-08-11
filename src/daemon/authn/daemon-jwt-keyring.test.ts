import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { parseSecretsEnv } from '../../client/authn/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
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

const LEGACY_V1 = TEST_ONLY_TURBOPANEL_SECRET
const PLURAL_V2 = 'Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7'
const PLURAL_V3 = 'Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4_Oo5Pp6Qq7Rr8'

/** Deno's JsonWebKey lib typing omits optional `kid` used on JWKS entries. */
function jwkKid(jwk: JsonWebKey): string | undefined {
  const kid = (jwk as { kid?: unknown }).kid
  return typeof kid === 'string' ? kid : undefined
}

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
    const kid = jwkKid(jwk)
    assertEquals(typeof kid, 'string')
    assertEquals(keyring.verifiers.has(kid!), true)
  }
})

test(
  'deriveDaemonJwtKeyring keeps first plural entry active when parseSecretsEnv folds legacy TURBOPANEL_SECRET',
  async () => {
    // Real migration shape: ordered TURBOPANEL_SECRETS + folded decrypt-only v1.
    const config = parseSecretsEnv(
      LEGACY_V1,
      `3:${PLURAL_V3},2:${PLURAL_V2}`,
      'deno',
    )
    assertEquals(config.versioned.map((v) => v.version), [3, 2, 1])
    assertEquals(config.versioned[0]?.value, PLURAL_V3)
    assertEquals(config.versioned[2], { version: 1, value: LEGACY_V1 })

    const keyring = await deriveDaemonJwtKeyring(config)
    const fromFirstPluralOnly = await deriveDaemonJwtKeyring({
      versioned: [{ version: 3, value: PLURAL_V3 }],
    })
    assertEquals(keyring.active.kid, fromFirstPluralOnly.active.kid)
    assertEquals(keyring.publicJwks.length, 3)
    assertEquals(keyring.verifiers.size, 3)

    for (const entry of config.versioned) {
      const alone = await deriveDaemonJwtKeyring({ versioned: [entry] })
      assertEquals(keyring.verifiers.has(alone.active.kid), true)
      assertEquals(
        keyring.publicJwks.some((jwk) => jwkKid(jwk) === alone.active.kid),
        true,
      )
    }
  },
)

test('buildJwksDocument returns public keys only', async () => {
  const keyring = await deriveDaemonJwtKeyring({
    versioned: [{ version: 1, value: 'jwks_test_secret' }],
  })
  const doc = buildJwksDocument(keyring)
  assertEquals(doc.keys, keyring.publicJwks)
  assertEquals(jwkKid(doc.keys[0]!), keyring.active.kid)
})
