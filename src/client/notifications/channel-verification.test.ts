/**
 * Channel verification against a real Postgres: the token is stored only as a
 * hash, a link works once and for one day, a resend replaces the link and is
 * rate-limited, and confirming abandons what piled up while unverified.
 * Skipped without TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals, assertNotEquals } from '@std/assert'
import { eq, like } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  notificationChannel,
  notificationDelivery,
  organization,
  verification,
} from '../../db/schema.ts'
import {
  CHANNEL_VERIFICATION_EXPIRES_IN_MS,
  CHANNEL_VERIFICATION_RESEND_COOLDOWN_MS,
  CHANNEL_VERIFICATION_TOKEN_PATTERN,
  channelVerificationCooldownSeconds,
  confirmChannelVerification,
  mintChannelVerificationToken,
} from './channel-verification.ts'
import { createNotificationChannel } from '../../features/notifications/records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

async function withChannel(
  fn: (ctx: { db: ReturnType<typeof createDenoDb>; channelId: string }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('channel verification tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Verify Org' })
    .returning({ id: organization.id })
  const channel = await createNotificationChannel(db, undefined, {
    scope: 'organization',
    organizationId: org!.id,
    kind: 'email',
    label: 'Pager',
    address: `pager-${crypto.randomUUID()}@example.com`,
  })
  try {
    await fn({ db, channelId: channel.id })
  } finally {
    await db.delete(verification).where(like(verification.identifier, `notification-channel:%`))
    await db.delete(organization).where(eq(organization.id, org!.id))
    await endDbConnection(db)
  }
}

async function verifiedAt(db: ReturnType<typeof createDenoDb>, id: string) {
  const [row] = await db
    .select({ at: notificationChannel.verifiedAt })
    .from(notificationChannel)
    .where(eq(notificationChannel.id, id))
  return row?.at ?? null
}

function insertDelivery(
  db: ReturnType<typeof createDenoDb>,
  channelId: string,
  status: 'pending' | 'failed' | 'sent'
) {
  return db.insert(notificationDelivery).values({
    channelId,
    event: 'server.offline',
    severity: 'critical',
    payload: {},
    status,
    nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
  })
}

test('a minted token is 64 hex characters and only its hash is stored', async () => {
  await withChannel(async ({ db, channelId }) => {
    const token = await mintChannelVerificationToken(db, channelId)
    assertEquals(CHANNEL_VERIFICATION_TOKEN_PATTERN.test(token), true)
    const rows = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, `notification-channel:${channelId}`))
    assertEquals(rows.length, 1)
    assertNotEquals(rows[0]!.value, token)
    assertEquals(rows[0]!.value.includes(token), false)
    assertEquals(rows[0]!.value.length, 64)
  })
})

test('confirming stamps the channel, uses the link up and abandons stale deliveries', async () => {
  await withChannel(async ({ db, channelId }) => {
    await insertDelivery(db, channelId, 'pending')
    await insertDelivery(db, channelId, 'failed')
    await insertDelivery(db, channelId, 'sent')
    const token = await mintChannelVerificationToken(db, channelId)
    assertEquals(await confirmChannelVerification(db, token), channelId)
    assertNotEquals(await verifiedAt(db, channelId), null)
    assertEquals(await confirmChannelVerification(db, token), null)
    const rows = await db
      .select({ status: notificationDelivery.status, error: notificationDelivery.lastError })
      .from(notificationDelivery)
      .where(eq(notificationDelivery.channelId, channelId))
    assertEquals(rows.map((r) => r.status).sort(), ['abandoned', 'abandoned', 'sent'])
    assertEquals(
      rows
        .filter((r) => r.status === 'abandoned')
        .every((r) => r.error === 'unverified_when_written'),
      true
    )
  })
})

test('an unknown, mistyped or expired token confirms nothing', async () => {
  await withChannel(async ({ db, channelId }) => {
    assertEquals(await confirmChannelVerification(db, 'f'.repeat(64)), null)
    assertEquals(await confirmChannelVerification(db, ''), null)
    const token = await mintChannelVerificationToken(db, channelId)
    const later = Date.now() + CHANNEL_VERIFICATION_EXPIRES_IN_MS + 1000
    assertEquals(await confirmChannelVerification(db, token, later), null)
    assertEquals(await verifiedAt(db, channelId), null)
  })
})

test('asking again replaces the earlier link', async () => {
  await withChannel(async ({ db, channelId }) => {
    const first = await mintChannelVerificationToken(db, channelId)
    const second = await mintChannelVerificationToken(db, channelId)
    assertNotEquals(first, second)
    assertEquals(await confirmChannelVerification(db, first), null)
    assertEquals(await confirmChannelVerification(db, second), channelId)
  })
})

test('a token minted for another purpose never confirms a channel', async () => {
  await withChannel(async ({ db, channelId }) => {
    const token = 'a'.repeat(64)
    const { deriveLinkTokenVerifier } = await import('../authn/link-token.ts')
    await db.insert(verification).values({
      identifier: `reset-password:${channelId}`,
      value: await deriveLinkTokenVerifier('turbopanel-password-reset-verifier-v1', token),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    try {
      assertEquals(await confirmChannelVerification(db, token), null)
    } finally {
      await db
        .delete(verification)
        .where(eq(verification.identifier, `reset-password:${channelId}`))
    }
  })
})

test('a channel that is already verified is not re-stamped', async () => {
  await withChannel(async ({ db, channelId }) => {
    const stamp = '2026-01-01T00:00:00.000Z'
    await db
      .update(notificationChannel)
      .set({ verifiedAt: stamp })
      .where(eq(notificationChannel.id, channelId))
    const token = await mintChannelVerificationToken(db, channelId)
    assertEquals(await confirmChannelVerification(db, token), null)
    assertEquals(Date.parse((await verifiedAt(db, channelId))!), Date.parse(stamp))
  })
})

test('the resend cooldown counts down from the last mail and is zero with no live link', async () => {
  await withChannel(async ({ db, channelId }) => {
    const now = Date.now()
    assertEquals(await channelVerificationCooldownSeconds(db, channelId, now), 0)
    await mintChannelVerificationToken(db, channelId, now)
    const full = Math.ceil(CHANNEL_VERIFICATION_RESEND_COOLDOWN_MS / 1000)
    assertEquals(await channelVerificationCooldownSeconds(db, channelId, now), full)
    assertEquals(await channelVerificationCooldownSeconds(db, channelId, now + 30_000), full - 30)
    assertEquals(
      await channelVerificationCooldownSeconds(
        db,
        channelId,
        now + CHANNEL_VERIFICATION_RESEND_COOLDOWN_MS
      ),
      0
    )
  })
})
