import { eq } from 'drizzle-orm'
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { user, verification } from '../../lib/db/schema.ts'
import { CLIENT_API_PREFIX } from '../../surfaces.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import { createEmailVerificationToken } from './email-verification.ts'
import { registerAuthRoutes } from './http.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'

const dbUrl = getDatabaseUrl()

async function createAuthApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(
    TEST_ONLY_TURBOPANEL_SECRET,
    undefined,
    'deno',
  )
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  const client = new Hono()
  registerAuthRoutes(client, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
    emailFrom: 'noreply@turbopanel.local',
  })
  app.route(CLIENT_API_PREFIX, client)
  return { app }
}

it('createEmailVerificationToken stores a verifier digest, never the raw token', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping email-verification digest-at-rest test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }
  const db = createDenoDb()
  const email = `verify-digest-${crypto.randomUUID()}@example.com`
  try {
    const token = await createEmailVerificationToken(db, email)

    const rows = await db
      .select({ value: verification.value })
      .from(verification)
      .where(eq(verification.identifier, email))
    assertEquals(rows.length, 1)
    // The at-rest value must never be the plaintext link token.
    assertEquals(rows[0].value === token, false)
  } finally {
    await db.delete(verification).where(eq(verification.identifier, email))
  }
})

it('GET /auth/verify-email marks the user verified and consumes the token', async () => {
  if (!dbUrl) {
    console.warn(
      'Skipping verify-email route test: TURBOPANEL_DATABASE_URL not set',
    )
    return
  }

  const db = createDenoDb()
  const email = `verify-route-${crypto.randomUUID()}@example.com`
  const { app } = await createAuthApp(db)

  const [insertedUser] = await db
    .insert(user)
    .values({
      email,
      isEmailVerified: false,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  try {
    const token = await createEmailVerificationToken(db, email)

    const response = await app.request(
      `${CLIENT_API_PREFIX}/auth/verify-email?token=${encodeURIComponent(token)}`,
    )
    assertEquals(response.status, 200)
    const payload = (await response.json()) as { ok: boolean }
    assertEquals(payload.ok, true)

    // The user row is marked verified.
    const userRows = await db
      .select({ isEmailVerified: user.isEmailVerified })
      .from(user)
      .where(eq(user.id, userId))
    assertEquals(userRows[0]?.isEmailVerified, true)

    // The verification (token) row is consumed.
    const tokenRows = await db
      .select({ id: verification.id })
      .from(verification)
      .where(eq(verification.identifier, email))
    assertEquals(tokenRows.length, 0)
  } finally {
    await db.delete(verification).where(eq(verification.identifier, email))
    await db.delete(user).where(eq(user.id, userId))
  }
})
