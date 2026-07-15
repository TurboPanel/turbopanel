import { eq } from 'drizzle-orm'
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { verification } from '../../lib/db/schema.ts'
import {
  createEmailOtp,
  hashEmailForOtp,
  MAX_OTP_ATTEMPTS,
  verifyEmailOtp,
} from './email-otp.ts'

const dbUrl = getDatabaseUrl()

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
  const email = `otp-cooldown-${crypto.randomUUID()}@example.com`
  try {
    const first = await createEmailOtp(db, email, 'sign-in')
    assertEquals(first.status, 'created')

    const second = await createEmailOtp(db, email, 'sign-in')
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
  const email = `otp-replace-${crypto.randomUUID()}@example.com`
  try {
    const first = await createEmailOtp(db, email, 'sign-in', 300, {
      cooldownMs: 0,
    })
    assertEquals(first.status, 'created')

    const second = await createEmailOtp(db, email, 'sign-in', 300, {
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
  const email = `otp-attempts-${crypto.randomUUID()}@example.com`
  try {
    const created = await createEmailOtp(db, email, 'sign-in')
    const goodOtp = created.status === 'created' ? created.otp : ''

    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) {
      const r = await verifyEmailOtp(db, email, 'sign-in', '000000')
      assertEquals(r, 'invalid')
    }

    // Even the correct OTP is rejected once the attempts cap is reached.
    const afterCap = await verifyEmailOtp(db, email, 'sign-in', goodOtp)
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
  const email = `otp-concurrent-${crypto.randomUUID()}@example.com`
  try {
    const created = await createEmailOtp(db, email, 'sign-in')
    const goodOtp = created.status === 'created' ? created.otp : ''

    // Fire the max number of wrong attempts concurrently. If attempts were not
    // atomic, lost updates would leave the counter below the cap and let the
    // correct OTP through afterward.
    await Promise.all(
      Array.from({ length: MAX_OTP_ATTEMPTS }, () =>
        verifyEmailOtp(db, email, 'sign-in', '000000')),
    )

    const afterConcurrent = await verifyEmailOtp(db, email, 'sign-in', goodOtp)
    assertEquals(afterConcurrent, 'too_many_attempts')
  } finally {
    await cleanupOtp(db, email)
  }
})
