import { eq } from 'drizzle-orm'
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { verification } from '../../lib/db/schema.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  createEmailOtp,
  deriveOtpVerifier,
  hashEmailForOtp,
  MAX_OTP_ATTEMPTS,
  OTP_VERIFIER_SECRET_PURPOSE,
  requireOtpVerifierSecrets,
  verifyEmailOtp,
  verifyOtpVerifier,
} from './email-otp.ts'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
  type DerivedSecretsConfig,
} from './secrets.ts'

const dbUrl = getDatabaseUrl()

async function testOtpSecrets(): Promise<DerivedSecretsConfig> {
  const config = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  return deriveSecretsConfig(config, OTP_VERIFIER_SECRET_PURPOSE)
}

async function cleanupOtp(
  db: ReturnType<typeof createDenoDb>,
  email: string,
): Promise<void> {
  const hash = await hashEmailForOtp(email)
  await db
    .delete(verification)
    .where(eq(verification.identifier, `otp:sign-in:${hash}`))
  await db
    .delete(verification)
    .where(eq(verification.identifier, `otp-attempts:sign-in:${hash}`))
}

it('createEmailOtp enforces a resend cooldown', async () => {
  if (!dbUrl) {
    console.warn('Skipping OTP cooldown test: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const secrets = await testOtpSecrets()
  const email = `otp-cooldown-${crypto.randomUUID()}@example.com`
  try {
    const first = await createEmailOtp(db, email, 'sign-in', secrets)
    assertEquals(first.status, 'created')

    const second = await createEmailOtp(db, email, 'sign-in', secrets)
    assertEquals(second.status, 'cooldown')
  } finally {
    await cleanupOtp(db, email)
  }
})

it('createEmailOtp with zero cooldown replaces the OTP', async () => {
  if (!dbUrl) {
    console.warn('Skipping OTP replace test: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const secrets = await testOtpSecrets()
  const email = `otp-replace-${crypto.randomUUID()}@example.com`
  try {
    const first = await createEmailOtp(db, email, 'sign-in', secrets, 300, {
      cooldownMs: 0,
    })
    assertEquals(first.status, 'created')

    const second = await createEmailOtp(db, email, 'sign-in', secrets, 300, {
      cooldownMs: 0,
    })
    assertEquals(second.status, 'created')
  } finally {
    await cleanupOtp(db, email)
  }
})

it('verifyEmailOtp locks out after MAX_OTP_ATTEMPTS failures', async () => {
  if (!dbUrl) {
    console.warn('Skipping OTP attempts test: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const secrets = await testOtpSecrets()
  const email = `otp-attempts-${crypto.randomUUID()}@example.com`
  try {
    const created = await createEmailOtp(db, email, 'sign-in', secrets)
    const goodOtp = created.status === 'created' ? created.otp : ''

    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
      const r = await verifyEmailOtp(db, email, 'sign-in', '000000', secrets)
      assertEquals(r, 'invalid')
    }

    // Even the correct OTP is rejected once the attempts cap is reached.
    const afterCap = await verifyEmailOtp(db, email, 'sign-in', goodOtp, secrets)
    assertEquals(afterCap, 'too_many_attempts')
  } finally {
    await cleanupOtp(db, email)
  }
})

it('concurrent wrong OTP attempts are counted atomically (no lost updates)', async () => {
  if (!dbUrl) {
    console.warn('Skipping OTP concurrency test: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const secrets = await testOtpSecrets()
  const email = `otp-concurrent-${crypto.randomUUID()}@example.com`
  try {
    const created = await createEmailOtp(db, email, 'sign-in', secrets)
    const goodOtp = created.status === 'created' ? created.otp : ''

    // Fire the max number of wrong attempts concurrently. If attempts were not
    // atomic, lost updates would leave the counter below the cap and let the
    // correct OTP through afterward.
    await Promise.all(
      Array.from({ length: MAX_OTP_ATTEMPTS }, () =>
        verifyEmailOtp(db, email, 'sign-in', '000000', secrets)),
    )

    const afterConcurrent = await verifyEmailOtp(
      db,
      email,
      'sign-in',
      goodOtp,
      secrets,
    )
    assertEquals(afterConcurrent, 'too_many_attempts')
  } finally {
    await cleanupOtp(db, email)
  }
})

it('createEmailOtp stores a keyed HMAC verifier, never the raw OTP', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping OTP digest-at-rest test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }
  const db = createDenoDb()
  const secrets = await testOtpSecrets()
  const email = `otp-digest-${crypto.randomUUID()}@example.com`
  try {
    const created = await createEmailOtp(db, email, 'sign-in', secrets, 300, {
      cooldownMs: 0,
    })
    assertEquals(created.status, 'created')
    const otp = created.status === 'created' ? created.otp : ''

    const hash = await hashEmailForOtp(email)
    const rows = await db
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, `otp:sign-in:${hash}`))
    assertEquals(rows.length, 1)
    // The at-rest value must never be the plaintext OTP.
    assertEquals(rows[0].value === otp, false)
    assertEquals(rows[0].value.startsWith(`v${secrets.current.version}.`), true)

    // The correct OTP still verifies against the stored HMAC.
    const ok = await verifyEmailOtp(db, email, 'sign-in', otp, secrets)
    assertEquals(ok, 'ok')
  } finally {
    await cleanupOtp(db, email)
  }
})

it('stored OTP verifier cannot be validated with only the database value', async () => {
  const secrets = await testOtpSecrets()
  const otherConfig = parseSecretsEnv(
    // Distinct fixture secret — offline attacker without TURBOPANEL_SECRET.
    'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8_Nn7Mm6Ll5Kk4',
    undefined,
    'deno',
  )
  const wrongSecrets = await deriveSecretsConfig(
    otherConfig,
    OTP_VERIFIER_SECRET_PURPOSE,
  )

  const emailHash = await hashEmailForOtp('offline-attack@example.com')
  const otp = '123456'
  const stored = await deriveOtpVerifier('sign-in', emailHash, otp, secrets)

  // Correct secret verifies.
  assertEquals(
    await verifyOtpVerifier('sign-in', emailHash, otp, stored, secrets),
    true,
  )
  // Wrong server secret cannot validate the same stored row + OTP.
  assertEquals(
    await verifyOtpVerifier('sign-in', emailHash, otp, stored, wrongSecrets),
    false,
  )
  // Brute-forcing the six-digit space against a wrong key also fails.
  assertEquals(
    await verifyOtpVerifier('sign-in', emailHash, '000000', stored, wrongSecrets),
    false,
  )
})

it('rotated fallback OTP keys still verify existing verifiers', async () => {
  const oldConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const oldSecrets = await deriveSecretsConfig(
    oldConfig,
    OTP_VERIFIER_SECRET_PURPOSE,
  )

  const emailHash = await hashEmailForOtp('rotation@example.com')
  const otp = '654321'
  const storedUnderV1 = await deriveOtpVerifier(
    'sign-in',
    emailHash,
    otp,
    oldSecrets,
  )
  assertEquals(storedUnderV1.startsWith('v1.'), true)

  // Rotate: new current key (v2) with v1 as fallback.
  const rotatedConfig = parseSecretsEnv(
    undefined,
    `2:Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3_Nn4Oo5Pp6Qq7,1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    'deno',
  )
  const rotatedSecrets = await deriveSecretsConfig(
    rotatedConfig,
    OTP_VERIFIER_SECRET_PURPOSE,
  )
  assertEquals(rotatedSecrets.current.version, 2)
  assertEquals(rotatedSecrets.fallbacks[0]?.version, 1)

  assertEquals(
    await verifyOtpVerifier(
      'sign-in',
      emailHash,
      otp,
      storedUnderV1,
      rotatedSecrets,
    ),
    true,
  )
})

it('requireOtpVerifierSecrets fails closed when the keyring is missing', () => {
  try {
    requireOtpVerifierSecrets(undefined)
    throw new Error('expected requireOtpVerifierSecrets to throw')
  } catch (err) {
    assertEquals(err instanceof Error, true)
    assertEquals(
      (err as Error).message.includes('OTP verifier secrets are required'),
      true,
    )
  }
})

it('parallel first-time createEmailOtp leaves only one active OTP row', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping OTP create concurrency test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }
  const db = createDenoDb()
  const secrets = await testOtpSecrets()
  const email = `otp-create-race-${crypto.randomUUID()}@example.com`
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createEmailOtp(db, email, 'sign-in', secrets, 300, { cooldownMs: 0 })),
    )
    const created = results.filter((r) => r.status === 'created')
    assertEquals(created.length >= 1, true)

    const hash = await hashEmailForOtp(email)
    const rows = await db
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.identifier, `otp:sign-in:${hash}`))
    assertEquals(rows.length, 1)
  } finally {
    await cleanupOtp(db, email)
  }
})
