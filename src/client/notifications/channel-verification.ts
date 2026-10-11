/**
 * Email-channel address verification: the emailed one-time link that proves a
 * person controls an address before notifications are sent to it.
 *
 * Token handling is the password-reset pattern, unchanged (`password-reset.ts`,
 * `link-token.ts`): 256 random bits, stored at rest only as a purpose-bound
 * SHA-256 verifier in the existing `verification` table (no new table), one row
 * per channel so asking again replaces the earlier link.
 *
 * Confirming a link stamps `channel.verified_at`. Deliveries that piled up
 * while the address was unverified are abandoned at that moment, so a freshly
 * confirmed address never receives a burst of stale events.
 */
import { and, count, eq, gt, inArray, isNull, like, lte, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { notificationChannel, notificationDelivery, verification } from '../../db/schema.ts'
import { deriveLinkTokenVerifier, generateLinkToken } from '../authn/link-token.ts'

/** A verification link works for one day. */
export const CHANNEL_VERIFICATION_EXPIRES_IN_MS = 24 * 60 * 60 * 1000

/** The shortest gap between two verification emails for one channel. */
export const CHANNEL_VERIFICATION_RESEND_COOLDOWN_MS = 60_000

/** Link tokens are 64 hex characters (`link-token.ts`). */
export const CHANNEL_VERIFICATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/

/** Domain separation: a reset or sign-up token can never confirm a channel. */
const VERIFIER_CONTEXT = 'turbopanel-notification-channel-verifier-v1'

/** `verification.identifier` prefix; the channel id follows. */
const IDENTIFIER_PREFIX = 'notification-channel:'

function nowIso(now: number): string {
  return new Date(now).toISOString()
}

/** Mint the link token for a channel; the previous link (if any) stops working. */
export async function mintChannelVerificationToken(
  db: Db,
  channelId: string,
  now: number = Date.now()
): Promise<string> {
  const token = generateLinkToken()
  const verifier = await deriveLinkTokenVerifier(VERIFIER_CONTEXT, token)
  const expiresAt = nowIso(now + CHANNEL_VERIFICATION_EXPIRES_IN_MS)
  await db
    .insert(verification)
    .values({
      identifier: `${IDENTIFIER_PREFIX}${channelId}`,
      value: verifier,
      expiresAt,
      updatedAt: nowIso(now),
    })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: { value: verifier, expiresAt, updatedAt: nowIso(now) },
    })
  return token
}

/**
 * Seconds until another verification email may be sent for the channel, or 0
 * when one may go now. Read off the live row's last write, so it holds across
 * isolates and restarts.
 */
export async function channelVerificationCooldownSeconds(
  db: Db,
  channelId: string,
  now: number = Date.now()
): Promise<number> {
  const [row] = await db
    .select({ updatedAt: verification.updatedAt })
    .from(verification)
    .where(
      and(
        eq(verification.identifier, `${IDENTIFIER_PREFIX}${channelId}`),
        gt(verification.expiresAt, nowIso(now))
      )
    )
    .limit(1)
  if (!row) return 0
  const readyAt = Date.parse(row.updatedAt) + CHANNEL_VERIFICATION_RESEND_COOLDOWN_MS
  return Math.max(0, Math.ceil((readyAt - now) / 1000))
}

/** Deliveries written before the address was confirmed are not replayed to it. */
async function abandonUnverifiedDeliveries(db: Db, channelId: string, now: number): Promise<void> {
  await db
    .update(notificationDelivery)
    .set({ status: 'abandoned', nextAttemptAt: null, lastError: 'unverified_when_written' })
    .where(
      and(
        eq(notificationDelivery.channelId, channelId),
        inArray(notificationDelivery.status, ['pending', 'failed']),
        lte(notificationDelivery.createdAt, nowIso(now))
      )
    )
}

async function takeLiveRow(db: Db, token: string, now: number): Promise<string | null> {
  const verifier = await deriveLinkTokenVerifier(VERIFIER_CONTEXT, token)
  const deleted = await db
    .delete(verification)
    .where(
      and(
        eq(verification.value, verifier),
        like(verification.identifier, `${IDENTIFIER_PREFIX}%`),
        gt(verification.expiresAt, nowIso(now))
      )
    )
    .returning({ identifier: verification.identifier })
  const identifier = deleted[0]?.identifier
  return identifier === undefined ? null : identifier.slice(IDENTIFIER_PREFIX.length)
}

/**
 * Use up a live token and verify its channel. Returns the channel id, or
 * `null` when the token is unknown, used, expired, or its channel is gone or
 * was already verified. The delete is the claim, so two clicks never both win.
 */
export async function confirmChannelVerification(
  db: Db,
  token: string,
  now: number = Date.now()
): Promise<string | null> {
  const channelId = await takeLiveRow(db, token, now)
  if (channelId === null) return null
  const stamped = await db
    .update(notificationChannel)
    .set({ verifiedAt: nowIso(now) })
    .where(
      and(
        eq(notificationChannel.id, channelId),
        eq(notificationChannel.kind, 'email'),
        isNull(notificationChannel.verifiedAt)
      )
    )
    .returning({ id: notificationChannel.id })
  if (stamped.length === 0) return null
  await abandonUnverifiedDeliveries(db, channelId, now)
  return channelId
}

/**
 * Brakes on verification mail. A verification mail goes to an address whose
 * owner never asked for it, so who may trigger one, and how often one address
 * may be mailed, is bounded here rather than left to the generic write limiter.
 */
export const CHANNEL_VERIFICATION_LIMITS = {
  /** Unverified email channels one user may have created at any time. */
  unverifiedPerUser: 5,
  /** Unverified email channels one organization may hold at any time. */
  unverifiedPerOrganization: 10,
  /** Verification mails one user may trigger per day, kept even if channels are deleted. */
  mailsPerUserPerDay: 10,
  /** Verification mails any one address receives per day, whoever asked. */
  mailsPerAddressPerDay: 3,
} as const

const MAIL_COUNTER_PREFIX = 'channel-verify-mail:'
const MAIL_COUNTER_WINDOW_MS = 24 * 60 * 60 * 1000

/** How many unverified email channels a user (or an organization) holds right now. */
export async function countUnverifiedEmailChannels(
  db: Db,
  owner: { userId: string } | { organizationId: string }
): Promise<number> {
  const ownerFilter =
    'userId' in owner
      ? eq(notificationChannel.createdByUserId, owner.userId)
      : eq(notificationChannel.organizationId, owner.organizationId)
  const [row] = await db
    .select({ n: count() })
    .from(notificationChannel)
    .where(
      and(
        eq(notificationChannel.kind, 'email'),
        isNull(notificationChannel.verifiedAt),
        ownerFilter
      )
    )
  return row?.n ?? 0
}

async function mailCounterIdentifier(kind: 'user' | 'address', key: string): Promise<string> {
  const bytes = new TextEncoder().encode(key.trim().toLowerCase())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${MAIL_COUNTER_PREFIX}${kind}:${hex}`
}

/**
 * Count one verification mail against a per-day allowance, atomically.
 *
 * The counter is one row in the `verification` table (identifier only; the
 * address is hashed, never stored) whose `expires_at` is the end of the
 * current day-long window. The upsert either starts a new window or adds one
 * in a single statement, so concurrent requests cannot both slip under the
 * limit. A request over the limit is refused and still counted, which keeps a
 * hammering caller refused for the rest of the window.
 */
export async function reserveVerificationMail(
  db: Db,
  kind: 'user' | 'address',
  key: string,
  limit: number,
  now: number = Date.now()
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const identifier = await mailCounterIdentifier(kind, key)
  const nowText = nowIso(now)
  const windowEnd = nowIso(now + MAIL_COUNTER_WINDOW_MS)
  const expired = sql`${verification.expiresAt} <= ${nowText}::timestamptz`
  const [row] = await db
    .insert(verification)
    .values({ identifier, value: '1', expiresAt: windowEnd, updatedAt: nowText })
    .onConflictDoUpdate({
      target: verification.identifier,
      set: {
        value: sql`CASE WHEN ${expired} THEN '1' ELSE (${verification.value}::int + 1)::text END`,
        expiresAt: sql`CASE WHEN ${expired} THEN ${windowEnd}::timestamptz ELSE ${verification.expiresAt} END`,
        updatedAt: nowText,
      },
    })
    .returning({ value: verification.value, expiresAt: verification.expiresAt })
  const used = Number(row?.value ?? '1')
  if (used <= limit) return { ok: true }
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((Date.parse(row?.expiresAt ?? windowEnd) - now) / 1000)
  )
  return { ok: false, retryAfterSeconds }
}
