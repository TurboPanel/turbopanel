import { assertEquals, assertExists } from '@std/assert'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../../client/authn/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
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
    parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'workers'),
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
      { challengeId: 'not.a.valid.token', serverId: 'srv-1', keyId: 'key-1' },
      DAEMON_ENROLL_AUTH_CHALLENGE_TTL_MS,
      now,
    ),
    null,
  )

  const [payload, sig] = issued.id.split('.')
  // Last base64url char can be padding-equivalent; truncate the signature instead.
  const tamperedSig = sig.slice(0, Math.max(1, sig.length - 8))
  assertEquals(
    await consumeChallenge(
      secrets,
      { challengeId: `${payload}.${tamperedSig}`, serverId: 'srv-1', keyId: 'key-1' },
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
      { challengeId: `${tamperedPayload}.${sig}`, serverId: 'srv-1', keyId: 'key-1' },
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
