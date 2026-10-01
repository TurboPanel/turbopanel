/**
 * Email channels for any address, confirmed by an emailed link.
 *
 *   POST /notification-channels/email          create an email channel. The caller's
 *                                              own address (user scope) or a member's
 *                                              account email (organization scope) is
 *                                              verified at once; any other address is
 *                                              created unverified and sent a link.
 *   POST /notification-channels/:id/verify     send the link again (one per minute).
 *   GET  /notification-channels/verify/:token  the link itself: no session (the person
 *                                              who owns the address may have no account),
 *                                              redirects to an allowlisted page.
 *
 * Registered before `registerNotificationRoutes`, whose catch-all session
 * middleware would otherwise sit in front of the link. The two authenticated
 * routes attach the session middleware themselves.
 */
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { getDb } from '../../db/connection.ts'
import { getEmailQueue } from '../../features/email/types.ts'
import {
  CHANNEL_VERIFICATION_TOKEN_PATTERN,
  channelVerificationCooldownSeconds,
  confirmChannelVerification,
  mintChannelVerificationToken,
} from './channel-verification.ts'
import {
  createNotificationChannel,
  deleteChannel,
  getChannel,
  type NotificationChannelRecord,
  organizationMemberEmails,
  organizationName,
  replaceRulesForChannel,
  resolveChannelAddress,
} from '../../features/notifications/records.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { assertCanOr403 } from '../authz/http.ts'
import { type AuthRouteOpts, resolveVerificationBaseUrlAsync } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { getOrgId } from '../shared.ts'
import { parseChannelCreateBody } from './routes-helpers.ts'

/**
 * Where the link lands. Both are fixed constants: the redirect target is never
 * request text, so a link can not send anyone off-site.
 */
export const CHANNEL_VERIFIED_PAGE = '/account/notifications?channelVerified=1'
export const CHANNEL_VERIFY_FAILED_PAGE = '/account/notifications?channelVerified=0'

type Ctx = Context<AppEnv>
type Db = NonNullable<ReturnType<typeof getDb>>

/** What a caller needs to know to turn a channel on: its owner may differ from the caller. */
async function organizationForWrite(c: Ctx, userId: string): Promise<string | Response> {
  const orgId = await getOrgId(c, userId)
  if (orgId instanceof Response) return orgId
  const denied = await assertCanOr403(c, 'organization:manage', 'organization', orgId)
  return denied ?? orgId
}

async function ownedEmailChannel(
  c: Ctx,
  db: Db,
  userId: string,
  id: string
): Promise<NotificationChannelRecord | Response> {
  const channel = await getChannel(db, id)
  if (channel === null || channel.scope === 'instance') {
    return c.json({ error: 'Not found' }, 404)
  }
  if (channel.scope === 'user') {
    return channel.userId === userId ? channel : c.json({ error: 'Not found' }, 404)
  }
  const denied = await assertCanOr403(
    c,
    'organization:manage',
    'organization',
    channel.organizationId!
  )
  return denied ?? channel
}

async function addressKnownToBelongHere(
  db: Db,
  sessionEmail: string,
  address: string,
  organizationId: string | null
): Promise<boolean> {
  const known = organizationId
    ? await organizationMemberEmails(db, organizationId)
    : new Set([sessionEmail.toLowerCase()])
  return known.has(address.toLowerCase())
}

/**
 * Mint a token and queue the link. Throws when there is no queue or the
 * queue refuses, so the caller can answer honestly instead of pretending.
 */
async function sendVerificationEmail(
  c: Ctx,
  opts: AuthRouteOpts,
  db: Db,
  channel: NotificationChannelRecord,
  address: string,
  requestedByEmail: string
): Promise<void> {
  const queue = getEmailQueue(c)
  if (!queue) throw new Error('email_unavailable')
  const token = await mintChannelVerificationToken(db, channel.id)
  const base = await resolveVerificationBaseUrlAsync(c, opts)
  await queue.enqueue({
    type: 'channel-verification',
    to: address,
    from: c.get('emailFrom') ?? opts.emailFrom ?? 'noreply@turbopanel.local',
    verifyUrl: `${base}${CLIENT_API_PREFIX}/notification-channels/verify/${token}`,
    channelLabel: channel.label,
    organizationName: channel.organizationId
      ? await organizationName(db, channel.organizationId)
      : null,
    requestedByEmail,
  })
}

function presentCreated(channel: NotificationChannelRecord, address: string) {
  return {
    id: channel.id,
    scope: channel.scope,
    organizationId: channel.organizationId,
    kind: channel.kind,
    label: channel.label,
    address,
    verifiedAt: channel.verifiedAt,
  }
}

type CreatePlan = { organizationId: string | null; body: unknown }

async function planCreate(c: Ctx, userId: string): Promise<CreatePlan | Response> {
  const raw = await c.req.json().catch(() => null)
  const body =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw, kind: 'email' } : raw
  const scope = (body as { scope?: unknown } | null)?.scope
  if (scope !== 'organization') return { organizationId: null, body }
  const org = await organizationForWrite(c, userId)
  return org instanceof Response ? org : { organizationId: org, body }
}

async function createEmailChannel(c: Ctx, opts: AuthRouteOpts): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const plan = await planCreate(c, sess.userId)
  if (plan instanceof Response) return plan
  const parsed = await parseChannelCreateBody(plan.body, { allowPrivateTargets: true })
  if (!parsed.ok) {
    const refusal = { error: parsed.error, ...(parsed.reason ? { reason: parsed.reason } : {}) }
    return c.json(refusal, parsed.status)
  }
  const { address, label, rules, scope } = parsed.value
  const verifiedNow = await addressKnownToBelongHere(db, sess.email, address, plan.organizationId)
  if (!verifiedNow && !getEmailQueue(c)) {
    return c.json({ error: 'email_unavailable' }, 503)
  }
  const channel = await createNotificationChannel(db, undefined, {
    scope,
    organizationId: plan.organizationId,
    userId: scope === 'user' ? sess.userId : null,
    kind: 'email',
    label,
    address,
    createdByUserId: sess.userId,
    verifiedAt: verifiedNow ? new Date().toISOString() : null,
  })
  await replaceRulesForChannel(db, channel.id, rules)
  if (verifiedNow) {
    return c.json(
      { ok: true, verification: 'not_needed', channel: presentCreated(channel, address) },
      201
    )
  }
  try {
    await sendVerificationEmail(c, opts, db, channel, address, sess.email)
  } catch (error) {
    compatLogWarn('notifications', `channel verification email failed: ${String(error)}`)
    await deleteChannel(db, channel.id)
    return c.json({ error: 'email_send_failed' }, 502)
  }
  return c.json({ ok: true, verification: 'sent', channel: presentCreated(channel, address) }, 201)
}

async function resendVerification(c: Ctx, opts: AuthRouteOpts): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const owned = await ownedEmailChannel(c, db, sess.userId, c.req.param('id') ?? '')
  if (owned instanceof Response) return owned
  if (owned.kind !== 'email') return c.json({ error: 'not_an_email_channel' }, 400)
  if (owned.verifiedAt !== null) return c.json({ error: 'already_verified' }, 409)
  const wait = await channelVerificationCooldownSeconds(db, owned.id)
  if (wait > 0) {
    c.header('Retry-After', String(wait))
    return c.json({ error: 'too_soon', retryAfterSeconds: wait }, 429)
  }
  const address = await resolveChannelAddress(undefined, owned)
  if (address === null) return c.json({ error: 'address_unreadable' }, 409)
  try {
    await sendVerificationEmail(c, opts, db, owned, address, sess.email)
  } catch (error) {
    const unavailable = error instanceof Error && error.message === 'email_unavailable'
    if (!unavailable)
      compatLogWarn('notifications', `channel verification email failed: ${String(error)}`)
    return unavailable
      ? c.json({ error: 'email_unavailable' }, 503)
      : c.json({ error: 'email_send_failed' }, 502)
  }
  return c.json({ ok: true })
}

async function followVerificationLink(c: Ctx): Promise<Response> {
  const token = c.req.param('token') ?? ''
  const db = getDb(c)
  const confirmed =
    db !== undefined &&
    CHANNEL_VERIFICATION_TOKEN_PATTERN.test(token) &&
    (await confirmChannelVerification(db, token)) !== null
  return c.redirect(confirmed ? CHANNEL_VERIFIED_PAGE : CHANNEL_VERIFY_FAILED_PAGE, 302)
}

export function registerNotificationVerifyRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts): void {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for notification routes')
  }
  const session = createSessionMiddleware(opts.secrets)
  router.get('/notification-channels/verify/:token', (c) => followVerificationLink(c))
  router.post('/notification-channels/email', session, (c) => createEmailChannel(c, opts))
  router.post('/notification-channels/:id/verify', session, (c) => resendVerification(c, opts))
}
