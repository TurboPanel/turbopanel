import { assertEquals, assertExists } from '@std/assert'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../../client/authn/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET, parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
  consumeChallenge,
  createStatelessChallengeStore,
  issueChallenge,
} from './stateless-challenge.ts'
import {
  DAEMON_CHALLENGE_TTL_MS,
  isDaemonChallengeFresh,
  issueDaemonChallenge,
} from '../authn/challenge.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function challengeSecrets() {
  return await deriveSecretsConfig(
    parseTestSecretsConfig('workers'),
    'daemon-challenge-signing',
  )
}

test('issueDaemonChallenge produces a fresh nonce within TTL', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const challenge = issueDaemonChallenge(now)
  assertExists(challenge.id)
  assertExists(challenge.nonce)
  assertEquals(challenge.at, new Date(now).toISOString())
  assertEquals(isDaemonChallengeFresh(challenge, now), true)
  assertEquals(
    isDaemonChallengeFresh(challenge, now + DAEMON_CHALLENGE_TTL_MS + 1),
    false,
  )
})

test('stateless challenge round-trips for matching server/key', async () => {
  const secrets = await challengeSecrets()
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const issued = await issueChallenge(
    secrets,
    { serverId: 'srv-1', keyId: 'key-1' },
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    now,
  )
  const consumed = await consumeChallenge(
    secrets,
    {
      challengeId: issued.id,
      serverId: 'srv-1',
      keyId: 'key-1',
    },
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    now + 1_000,
  )
  assertEquals(consumed, {
    id: issued.id,
    nonce: issued.nonce,
    at: issued.at,
  })
})

test('stateless challenge rejects mismatch, expiry, and tampering', async () => {
  const secrets = await challengeSecrets()
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const issued = await issueChallenge(
    secrets,
    { serverId: 'srv-1', keyId: 'key-1' },
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    now,
  )

  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: issued.id, serverId: 'other', keyId: 'key-1' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: issued.id, serverId: 'srv-1', keyId: 'other' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: issued.id, serverId: 'srv-1', keyId: 'key-1' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now + DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS + 1,
    ),
    null,
  )
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: 'tpsession.v1.not.a.challenge', serverId: 'srv-1', keyId: 'key-1' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )

  // tpchallenge.vN.<payload>.<sig> — indices [2]=payload, [3]=sig
  const parts = issued.id.split('.')
  const payload = parts[2]!
  const sig = parts[3]!
  // Last base64url char can be padding-equivalent; truncate the signature instead.
  const tamperedSig = sig.slice(0, Math.max(1, sig.length - 8))
  assertEquals(
    await consumeChallenge(
      secrets,
      {
        challengeId: `tpchallenge.v${secrets.current.version}.${payload}.${tamperedSig}`,
        serverId: 'srv-1',
        keyId: 'key-1',
      },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  // Payload tampering with an intact signature must also fail verification.
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`
  assertEquals(
    await consumeChallenge(
      secrets,
      {
        challengeId: `tpchallenge.v${secrets.current.version}.${tamperedPayload}.${sig}`,
        serverId: 'srv-1',
        keyId: 'key-1',
      },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
})

test('createStatelessChallengeStore exposes issue/consume', async () => {
  const secrets = await challengeSecrets()
  const store = createStatelessChallengeStore(
    secrets,
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
  )
  assertEquals(store.ttlMs, DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS)
  const issued = await store.issue({ serverId: 'srv-2' })
  const consumed = await store.consume({
    challengeId: issued.id,
    serverId: 'srv-2',
  })
  assertEquals(consumed?.nonce, issued.nonce)
})

test('stateless challenge honors embedded payload ttl over caller default', async () => {
  const secrets = await challengeSecrets()
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const shortTtlMs = 5_000
  const issued = await issueChallenge(
    secrets,
    { serverId: 'srv-ttl', keyId: 'key-ttl' },
    shortTtlMs,
    now,
  )
  const stillValid = await consumeChallenge(
    secrets,
    { challengeId: issued.id, serverId: 'srv-ttl', keyId: 'key-ttl' },
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    now + 1_000,
  )
  assertEquals(stillValid?.nonce, issued.nonce)

  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: issued.id, serverId: 'srv-ttl', keyId: 'key-ttl' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now + shortTtlMs + 1,
    ),
    null,
  )
})

test('stateless challenge rejects malformed ids and empty binding fields', async () => {
  const secrets = await challengeSecrets()
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const issued = await issueChallenge(secrets, {}, DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS, now)

  // Wrong scheme
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: 'tpsession.v1.payload.sig', serverId: '', keyId: '' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  // Missing version token
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: 'tpchallenge.payload.sig', serverId: '', keyId: '' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  // Empty field
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: 'tpchallenge.v1..sig', serverId: '', keyId: '' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  // Wrong field count
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: 'tpchallenge.v1.only-one', serverId: '', keyId: '' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  // Version absent from the keyring
  const issuedParts = issued.id.split('.')
  const payload = issuedParts[2]!
  const sig = issuedParts[3]!
  assertEquals(
    await consumeChallenge(
      secrets,
      {
        challengeId: `tpchallenge.v9.${payload}.${sig}`,
        serverId: '',
        keyId: '',
      },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: issued.id, serverId: 'unexpected', keyId: '' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
})

test('stateless challenge returns null for invalid base64url payload/signature segments', async () => {
  const secrets = await challengeSecrets()
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const version = secrets.current.version
  const encoder = new TextEncoder()

  // Invalid signature segment — parseEnvelope accepts it, base64urlDecode/atob would throw
  assertEquals(
    await consumeChallenge(
      secrets,
      {
        challengeId: `tpchallenge.v${version}.cGF5bG9hZA.%%%`,
        serverId: '',
        keyId: '',
      },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )

  // Valid HMAC over an invalid base64url payload segment — verify passes, parsePayload fails
  const badPayload = '%%%'
  const sigBytes = await crypto.subtle.sign(
    'HMAC',
    secrets.current.key,
    encoder.encode(badPayload),
  )
  let binary = ''
  for (const byte of new Uint8Array(sigBytes)) {
    binary += String.fromCodePoint(byte)
  }
  const encodedSig = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  assertEquals(
    await consumeChallenge(
      secrets,
      {
        challengeId: `tpchallenge.v${version}.${badPayload}.${encodedSig}`,
        serverId: '',
        keyId: '',
      },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )
})

test('stateless challenge verifies with fallback signing keys', async () => {
  const legacySecret =
    'Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7Rr8Ss9Tt0Uu1'
  const signing = await deriveSecretsConfig(
    parseSecretsEnv(`1:${legacySecret}`, 'workers'),
    'daemon-challenge-signing',
  )
  const verifying = await deriveSecretsConfig(
    parseSecretsEnv(`2:${TEST_ONLY_TURBOPANEL_SECRET},1:${legacySecret}`,
    'workers'),
    'daemon-challenge-signing',
  )
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const issued = await issueChallenge(
    signing,
    { serverId: 'srv-fallback', keyId: 'key-fallback' },
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    now,
  )
  const consumed = await consumeChallenge(
    verifying,
    {
      challengeId: issued.id,
      serverId: 'srv-fallback',
      keyId: 'key-fallback',
    },
    DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
    now,
  )
  assertEquals(consumed?.nonce, issued.nonce)
})
