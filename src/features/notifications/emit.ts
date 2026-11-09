/**
 * "This happened" → one `event` row, inbox rows and personal copies for the
 * people whose preferences ask for it, and one copy per shared channel a rule
 * routes it to.
 *
 * The one rule above all others, inherited from `alert-sender.ts`: **emitting
 * never fails the emitter.** The offline sweep's job is to demote stale
 * servers; a deploy route's job is to deploy. If the notifications table is
 * missing, Postgres is slow, or Slack is down, the thing being reported on
 * must still finish. So every phase here is bounded and caught, and the only
 * promise to a caller is that awaiting `emitNotification` terminates.
 *
 * Fan-out (redesigned 2026-11-06):
 * - recipients are the people the topic's audience names **now**: members of
 *   the organization, its managers, or the install's administrators for an
 *   install event; an administrator hears an organization only when they
 *   belong to it or switched on hearing every organization. The person who
 *   caused the event is left out.
 * - each recipient's preference rows decide the bell and every personal
 *   channel (`resolve.ts`); with no rows nothing arrives, the bell included.
 *   The built-in account email channel is created on first use and always
 *   sends to the current sign-in address.
 * - shared channels (organization and instance) are routed by rules as
 *   before; an organization email channel only reaches an address that still
 *   belongs to a member.
 *
 * Delivery runs inline, once, bounded; a failure leaves a `failed` ledger row
 * with a retry time that the maintenance tick (`retryDueDeliveries`) picks
 * up, up to the attempt cap. Push rows are never written (no transport yet).
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { type Db, runWithDbTimeout } from '../../db/connection.ts'
import { notificationChannel } from '../../db/schema.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential, mapSequential } from '../../lib/sequential.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { validateOutboundUrl } from '../../lib/http/outbound-url.ts'
import {
  describeEvent,
  eventAudience,
  eventCategory,
  eventIsUrgent,
  eventResource,
  eventScope,
  eventSeverity,
  type NotificationContext,
  type NotificationEvent,
  type NotificationSeverity,
} from './events.ts'
import {
  asChannel,
  channelsForEvent,
  channelTimeZones,
  type DeliveryPayload,
  getChannel,
  insertDeliveries,
  insertNotifications,
  claimDueDeliveries,
  type LedgerCopy,
  type NotificationChannelRecord,
  type NotificationDeliveryRecord,
  organizationMemberEmails,
  organizationName,
  recordDeliveryAttempt,
  resolveChannelAddress,
  resolveChannelSigningSecret,
} from './records.ts'
import {
  accountEmails,
  audienceRecipientIds,
  completeScope,
  ensureNotificationCatalog,
  ensurePrimaryEmailChannels,
  type EventScopeIds,
  insertEvent,
  markEventFannedOut,
  preferenceRowsFor,
  suppressedAddresses,
} from './fanout-records.ts'
import {
  type EventScope,
  levelAllows,
  preferenceKindForChannel,
  resolveLevel,
  rowsByUser,
  type PreferenceRow,
} from './resolve.ts'
import { dropUndeliverableCopies } from './cleanup.ts'
import { renderDetails, send, type SendOutcome } from './senders.ts'
import { sealUnsubscribeToken, unsubscribePageUrl, unsubscribeUrl } from './unsubscribe.ts'
import { shouldHoldNow } from './windows.ts'
import type { EmailJob, EmailQueue, NotificationMailHeaders } from '../email/types.ts'
import type { NotificationAttemptReason } from './vocabulary.ts'

export type EmitInput = {
  event: NotificationEvent
  /** Required for an organization-scoped event; ignored for an instance-scoped one. */
  organizationId?: string | null
  context?: NotificationContext
  targetType?: string | null
  targetId?: string | null
  /** Resource ids the event is about, beyond what the target says; parents are filled in. */
  scope?: Partial<EventScopeIds>
  /** Who caused it; that person is not told. */
  actorUserId?: string | null
  /** Folds repeats of an open event inside the topic's cooldown into one. */
  dedupe?: string | null
}

export type EmitEmail = {
  queue: EmailQueue
  from: string
  /** The console's public base URL, for the "Open in TurboPanel" link; null when unknown. */
  consoleBaseUrl?: string | null
}

export type EmitDeps = {
  fetchImpl?: typeof fetch
  /**
   * A LAN address is a legitimate target on every runtime (decided
   * 2026-09-18, "allow everywhere, no exceptions"); `false` is a test seam
   * for the strict gate the forge callers keep.
   */
  allowPrivateTargets?: boolean
  /** Without this, email channels' deliveries stay pending for a later tick that has a queue. */
  email?: EmitEmail
  now?: () => number
  trace?: (event: string, detail: Record<string, unknown>) => void
}

export type EmitResult = {
  inbox: number
  deliveries: number
  sent: number
  failed: number
  /** Deliveries written as `held`, waiting for quiet hours to end or a digest window to close. */
  held: number
}

const EMPTY: EmitResult = { inbox: 0, deliveries: 0, sent: 0, failed: 0, held: 0 }

/** How long the whole delivery phase of one emit may take. */
export const EMIT_DELIVERY_BUDGET_MS = 5_000

/** The resource ids an event's target names, for the topic's resource kind. */
function targetScope(input: EmitInput): Partial<EventScopeIds> {
  const fromTarget: Partial<EventScopeIds> = {}
  if (eventResource(input.event) === 'server' && input.targetType === 'server') {
    fromTarget.serverId = input.targetId ?? null
  }
  return { ...fromTarget, ...input.scope }
}

export async function emitNotification(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  input: EmitInput,
  deps: EmitDeps = {}
): Promise<EmitResult> {
  const trace = deps.trace ?? (() => {})
  try {
    const scope = eventScope(input.event)
    const organizationId = scope === 'organization' ? (input.organizationId ?? null) : null
    if (scope === 'organization' && !organizationId) {
      trace('notification-skipped', {
        event: input.event,
        reason: 'organization_required',
      })
      return EMPTY
    }
    await runWithDbTimeout(db, (tx) => ensureNotificationCatalog(tx))
    const context = input.context ?? {}
    const severity = eventSeverity(input.event)
    const { title, body } = describeEvent(input.event, context)
    const nowMs = deps.now?.() ?? Date.now()

    const written = await runWithDbTimeout(db, (tx) =>
      writeFanOut(tx, {
        input,
        organizationId,
        context,
        severity,
        title,
        body,
        nowMs,
      })
    )
    if (written === null) {
      trace('notification-folded', { event: input.event })
      return EMPTY
    }

    // Phase two: attempt each copy once, inside a budget.
    const byId = new Map(written.channels.map((c) => [c.id, c]))
    const outcome = await attemptDeliveries(
      db,
      secrets,
      written.deliveries
        .filter((d) => d.status === 'pending')
        .map((d) => ({
          delivery: d,
          channel: byId.get(d.channelId) ?? null,
        })),
      deps,
      EMIT_DELIVERY_BUDGET_MS
    )
    return {
      inbox: written.inbox,
      deliveries: written.deliveries.length,
      sent: outcome.sent,
      failed: outcome.failed,
      held: written.deliveries.filter((d) => d.status === 'held').length,
    }
  } catch (error) {
    compatLogWarn(
      'notifications',
      `emit ${input.event} failed: ${error instanceof Error ? error.message : String(error)}`
    )
    trace('notification-emit-failed', { event: input.event })
    return EMPTY
  }
}

type FanOutInput = {
  input: EmitInput
  organizationId: string | null
  context: NotificationContext
  severity: NotificationSeverity
  title: string
  body: string | null
  nowMs: number
}

type FanOutResult = {
  inbox: number
  channels: NotificationChannelRecord[]
  deliveries: NotificationDeliveryRecord[]
}

/** Personal channels of these people that can carry a copy (not paused, not push). */
async function personalChannels(
  db: Db,
  userIds: readonly string[]
): Promise<NotificationChannelRecord[]> {
  if (userIds.length === 0) return []
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(
      and(
        eq(notificationChannel.scope, 'user'),
        inArray(notificationChannel.userId, [...userIds]),
        isNull(notificationChannel.disabledAt),
        ne(notificationChannel.kind, 'push')
      )
    )
  return rows.map(asChannel)
}

/**
 * Phase one, in one bounded unit: the event row, the inbox rows, and a ledger
 * row for every copy (sent, held, or recorded as not sent with a reason).
 * Returns null when the event was folded into an open one.
 */
async function writeFanOut(tx: Db, f: FanOutInput): Promise<FanOutResult | null> {
  const { input, organizationId, context, severity, title, body } = f
  const categoryCode = eventCategory(input.event)
  const scopeIds = await completeScope(tx, organizationId, targetScope(input))
  const eventId = await insertEvent(tx, {
    organizationId,
    topicCode: input.event,
    scope: scopeIds,
    actorUserId: input.actorUserId ?? null,
    severity,
    dedupe: input.dedupe ?? null,
    data: {
      ...context,
      title,
      body,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
    },
  })
  if (eventId === null) return null

  const payload: DeliveryPayload = {
    event: input.event,
    severity,
    title,
    body,
    organizationId,
    organizationName: organizationId ? await organizationName(tx, organizationId) : null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    context,
    at: new Date(f.nowMs).toISOString(),
    eventId,
    categoryCode,
    ...scopeIds,
  }
  const eventScopeForRules: EventScope = {
    organizationId,
    ...scopeIds,
    topicCode: input.event,
    categoryCode,
  }

  const actor = input.actorUserId ?? null
  const recipients = (
    await audienceRecipientIds(tx, eventAudience(input.event), organizationId)
  ).filter((id) => id !== actor)
  const preferences = rowsByUser(await preferenceRowsFor(tx, recipients, organizationId))
  // Nobody with no rows hears anything; only people with rows need channels.
  const listening = recipients.filter((id) => preferences.has(id))
  await ensurePrimaryEmailChannels(tx, listening)

  const decide = (
    userId: string,
    kind: 'inbox' | 'email' | 'chat' | 'webhook',
    channelId: string | null
  ) =>
    levelAllows(
      resolveLevel(
        preferences.get(userId) ?? ([] as PreferenceRow[]),
        eventScopeForRules,
        { kind, channelId },
        f.nowMs
      ).level,
      severity
    )

  const inboxFor = listening.filter((userId) => decide(userId, 'inbox', null))
  const inbox = await insertNotifications(
    tx,
    inboxFor.map((userId) => ({
      userId,
      organizationId,
      event: input.event,
      severity,
      title,
      body,
      targetType: payload.targetType,
      targetId: payload.targetId,
      context,
      eventId,
      ...scopeIds,
    }))
  )

  const personal = (await personalChannels(tx, listening)).filter((channel) =>
    decide(
      channel.userId!,
      preferenceKindForChannel(channel.kind) as 'email' | 'chat' | 'webhook',
      channel.id
    )
  )
  const shared = await channelsForEvent(tx, input.event, severity, organizationId, categoryCode)
  const channels = [...personal, ...shared]
  const copies = await planCopies(tx, channels, organizationId, input.event, f.nowMs)
  const deliveries = await insertDeliveries(tx, copies, payload)
  await markEventFannedOut(tx, eventId)
  return { inbox, channels, deliveries }
}

/**
 * One ledger copy per channel, with what happens to it: sent now, held for a
 * window, or recorded and never sent (an unverified or suppressed address, an
 * organization email channel naming someone who left).
 */
async function planCopies(
  tx: Db,
  channels: readonly NotificationChannelRecord[],
  organizationId: string | null,
  event: NotificationEvent,
  nowMs: number
): Promise<LedgerCopy[]> {
  const personalIds = channels.flatMap((c) => (c.scope === 'user' && c.userId ? [c.userId] : []))
  const accounts = await accountEmails(tx, personalIds)
  const memberEmails =
    organizationId && channels.some((c) => c.scope === 'organization' && c.kind === 'email')
      ? await organizationMemberEmails(tx, organizationId)
      : new Set<string>()
  const emailOf = (c: NotificationChannelRecord): string | null => {
    if (c.kind !== 'email') return null
    if (c.isPrimary) return accounts.get(c.userId ?? '')?.email ?? null
    return c.address
  }
  const suppressed = await suppressedAddresses(
    tx,
    channels.flatMap((c) => {
      const address = emailOf(c)
      return address ? [address] : []
    })
  )
  const held = await heldReasons(tx, channels, event, nowMs)
  const emailCheck = { accounts, memberEmails, suppressed }
  return channels.map((channel): LedgerCopy => {
    const base = { channelId: channel.id, userId: channel.scope === 'user' ? channel.userId : null }
    const dropped = emailDrop(channel, emailOf(channel), emailCheck)
    if (dropped) return { ...base, ...dropped }
    const reason = held.get(channel.id)
    return reason ? { ...base, status: 'held', reason } : { ...base, status: 'pending' }
  })
}

/**
 * Why an email copy must not be sent, or null: an unverified address, an
 * organization channel naming someone who is no longer a member, or an
 * address on the suppression list.
 */
function emailDrop(
  channel: NotificationChannelRecord,
  address: string | null,
  check: {
    accounts: Map<string, { email: string; verified: boolean }>
    memberEmails: Set<string>
    suppressed: Set<string>
  }
): Pick<LedgerCopy, 'status' | 'reason'> | null {
  if (channel.kind !== 'email') return null
  const verified = channel.isPrimary
    ? check.accounts.get(channel.userId ?? '')?.verified === true
    : channel.verifiedAt !== null
  if (!verified || address === null) return { status: 'abandoned', reason: 'unverified' }
  const normalized = address.trim().toLowerCase()
  if (channel.scope === 'organization' && !check.memberEmails.has(normalized)) {
    return { status: 'abandoned', reason: 'no_access' }
  }
  if (check.suppressed.has(normalized)) return { status: 'suppressed', reason: 'bounced' }
  return null
}

/** Email, chat and webhook channels can wait for a window (push is the store apps'; an unverified address gets nothing). */
function canHoldFor(channel: NotificationChannelRecord): boolean {
  if (channel.kind === 'push') return false
  return channel.kind !== 'email' || channel.verifiedAt !== null || channel.isPrimary
}

/**
 * The channels that should wait rather than send now, with why: a digest
 * cadence, or quiet hours running, for an event that is not urgent. An urgent
 * event (outage, anything security-related) is never held and the bell is
 * never touched — only the external send waits.
 */
async function heldReasons(
  db: Db,
  channels: readonly NotificationChannelRecord[],
  event: NotificationEvent,
  nowMs: number
): Promise<Map<string, NotificationAttemptReason>> {
  if (eventIsUrgent(event)) return new Map()
  const candidates = channels.filter(
    (c) => canHoldFor(c) && (c.digestCadence !== null || c.quiet !== null)
  )
  if (candidates.length === 0) return new Map()
  const zones = await channelTimeZones(db, candidates)
  const out = new Map<string, NotificationAttemptReason>()
  for (const c of candidates) {
    const hold = shouldHoldNow(nowMs, zones.get(c.id) ?? 'UTC', {
      digestCadence: c.digestCadence,
      quiet: c.quiet,
    })
    if (hold) out.set(c.id, c.digestCadence !== null ? 'digest' : 'quiet_hours')
  }
  return out
}

/**
 * Sent from the ledger: never push (no transport yet), email only when this
 * tick has a queue to hand it to, never a disabled channel.
 */
function deliverableHere(
  channel: NotificationChannelRecord | null,
  deps: EmitDeps
): channel is NotificationChannelRecord {
  if (channel?.disabledAt !== null) return false
  if (channel.kind === 'push') return false
  // An email address is delivered to only once it is known to be the
  // recipient's (decided 2026-09-18); the account email channel always is.
  if (channel.kind === 'email') {
    return deps.email !== undefined && (channel.verifiedAt !== null || channel.isPrimary)
  }
  return true
}

/** Where the console shows the event's target, when it has one. */
export function consoleUrlFor(
  base: string | null | undefined,
  payload: DeliveryPayload
): string | null {
  if (!base) return null
  const root = base.endsWith('/') ? base.slice(0, -1) : base
  const serverId =
    payload.serverId ?? (payload.targetType === 'server' ? payload.targetId : null) ?? null
  if (payload.organizationId && serverId) {
    return `${root}/${payload.organizationId}/servers/${serverId}`
  }
  if (payload.organizationId) {
    return `${root}/${payload.organizationId}/overview`
  }
  return root
}

/** The settings screen a "manage all settings" link opens. */
export function settingsUrlFor(base: string, organizationId: string | null): string {
  const root = base.endsWith('/') ? base.slice(0, -1) : base
  return organizationId
    ? `${root}/${organizationId}/manage?tab=notifications`
    : `${root}/account/notifications`
}

/**
 * RFC 8058 unsubscribe and the filtering headers for one email copy. A
 * personal copy unsubscribes the person from that category's email in that
 * project (or organization); a shared channel's copy carries no unsubscribe
 * link (the organization's settings own it) but still says why it came.
 */
export async function mailHeadersFor(
  secrets: DerivedSecretsConfig | undefined,
  base: string | null | undefined,
  channel: NotificationChannelRecord,
  payload: DeliveryPayload,
  opts?: { categoryCode: string | null }
): Promise<NotificationMailHeaders> {
  const categoryCode = opts ? opts.categoryCode : (payload.categoryCode ?? null)
  const headers: NotificationMailHeaders = {
    organizationId: payload.organizationId,
    projectId: payload.projectId ?? null,
    event: payload.event,
    reason: channel.scope === 'user' ? 'preference' : `${channel.scope}-channel`,
  }
  if (!base) return headers
  headers.settingsUrl = settingsUrlFor(base, payload.organizationId)
  if (channel.scope !== 'user' || !channel.userId || !secrets) return headers
  const token = await sealUnsubscribeToken(secrets, {
    userId: channel.userId,
    organizationId: payload.organizationId,
    projectId: payload.organizationId ? (payload.projectId ?? null) : null,
    categoryCode,
    channelId: channel.isPrimary ? null : channel.id,
  })
  headers.unsubscribeUrl = unsubscribeUrl(base, token)
  headers.unsubscribePageUrl = unsubscribePageUrl(base, token)
  return headers
}

async function enqueueEmail(
  email: EmitEmail,
  secrets: DerivedSecretsConfig | undefined,
  channel: NotificationChannelRecord,
  to: string,
  payload: DeliveryPayload
): Promise<SendOutcome> {
  const job: EmailJob = {
    type: 'notification',
    to,
    from: email.from,
    event: payload.event,
    severity: payload.severity,
    title: payload.title,
    body: payload.body,
    details: renderDetails(payload),
    organizationName: payload.organizationName,
    consoleUrl: consoleUrlFor(email.consoleBaseUrl, payload),
    at: payload.at,
    mail: await mailHeadersFor(secrets, email.consoleBaseUrl, channel, payload),
  }
  try {
    await email.queue.enqueue(job)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `queue_${error.name}` : 'queue',
    }
  }
}

type AttemptOutcome = SendOutcome | { ok: false; error: string; drop: NotificationAttemptReason }

/**
 * The address a copy goes to now: the account's current sign-in address for
 * the built-in email channel, else the channel's own (unsealed). For an
 * organization email channel, null with `no_access` when the address no
 * longer belongs to a member (a person who left must stop getting mail).
 */
export async function deliveryAddress(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  channel: NotificationChannelRecord
): Promise<{ address: string } | { address: null; drop?: NotificationAttemptReason }> {
  if (channel.kind === 'email' && channel.isPrimary) {
    const accounts = await runWithDbTimeout(db, (tx) => accountEmails(tx, [channel.userId ?? '']))
    const account = accounts.get(channel.userId ?? '')
    if (!account?.verified) return { address: null, drop: 'unverified' }
    return { address: account.email }
  }
  const address = await resolveChannelAddress(secrets, channel)
  if (address === null) return { address: null }
  if (channel.kind === 'email' && channel.scope === 'organization' && channel.organizationId) {
    const members = await runWithDbTimeout(db, (tx) =>
      organizationMemberEmails(tx, channel.organizationId!)
    )
    if (!members.has(address.trim().toLowerCase())) return { address: null, drop: 'no_access' }
  }
  return { address }
}

async function attemptOne(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  channel: NotificationChannelRecord,
  delivery: NotificationDeliveryRecord,
  deps: EmitDeps
): Promise<AttemptOutcome> {
  const resolved = await deliveryAddress(db, secrets, channel)
  if (resolved.address === null) {
    return resolved.drop
      ? { ok: false, error: resolved.drop, drop: resolved.drop }
      : { ok: false, error: 'address_unreadable' }
  }
  const address = resolved.address
  if (channel.kind === 'email') {
    return deps.email
      ? await enqueueEmail(deps.email, secrets, channel, address, delivery.payload)
      : { ok: false, error: 'no_email_queue' }
  }
  // Re-validated at send, not only at write: a stored address may predate a
  // rule change or have been written by something other than the route.
  if (channel.kind !== 'telegram') {
    const rejection = validateOutboundUrl(address, {
      allowPrivate: deps.allowPrivateTargets !== false,
    })
    if (rejection) return { ok: false, error: `address_${rejection}` }
  }
  const signingSecret = await resolveChannelSigningSecret(secrets, channel)
  return await send(
    { kind: channel.kind, address, signingSecret },
    delivery.payload,
    deps.fetchImpl ?? fetch
  )
}

async function attemptDeliveries(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  items: ReadonlyArray<{
    delivery: NotificationDeliveryRecord
    channel: NotificationChannelRecord | null
  }>,
  deps: EmitDeps,
  budgetMs: number
): Promise<{ sent: number; failed: number }> {
  const deadline = (deps.now?.() ?? Date.now()) + budgetMs
  let sent = 0
  let failed = 0
  let budgetSpent = false
  await forEachSequential(items, async ({ delivery, channel }) => {
    if (budgetSpent || !deliverableHere(channel, deps)) return
    if ((deps.now?.() ?? Date.now()) >= deadline) {
      deps.trace?.('notification-delivery-deferred', {
        remaining: items.length - sent - failed,
      })
      budgetSpent = true
      return
    }
    const outcome = await attemptOne(db, secrets, channel, delivery, deps)
    if (outcome.ok) sent += 1
    else failed += 1
    try {
      await runWithDbTimeout(db, (tx) => recordDeliveryAttempt(tx, delivery.id, outcome))
    } catch (error) {
      compatLogWarn(
        'notifications',
        `could not record delivery ${delivery.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  })
  return { sent, failed }
}

/**
 * The maintenance tick's phase: drop copies that must not go out any more
 * (their scope was deleted, the person left), then retry failed deliveries
 * whose time has come, a bounded batch per tick. Same never-throws contract.
 */
export async function retryDueDeliveries(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  deps: EmitDeps = {},
  limit = 50
): Promise<{ attempted: number; sent: number; failed: number }> {
  try {
    await runWithDbTimeout(db, (tx) => dropUndeliverableCopies(tx))
    const due = await runWithDbTimeout(db, (tx) =>
      claimDueDeliveries(tx, limit, { includeEmail: deps.email !== undefined })
    )
    const items = await mapSequential(due, async (delivery) => {
      const channel = await runWithDbTimeout(db, (tx) => getChannel(tx, delivery.channelId))
      return { delivery, channel }
    })
    const outcome = await attemptDeliveries(db, secrets, items, deps, EMIT_DELIVERY_BUDGET_MS * 4)
    return { attempted: items.length, ...outcome }
  } catch (error) {
    compatLogWarn(
      'notifications',
      `retry sweep failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return { attempted: 0, sent: 0, failed: 0 }
  }
}
