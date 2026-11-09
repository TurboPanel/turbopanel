/**
 * Reads and writes for the four notification tables — the only module that
 * touches them, so the sealing rule and the vocabularies live in one place.
 *
 * Sealing: a channel's `address` is a `tpsecret` envelope for every kind but
 * `email`. A webhook URL is a credential (the path is the secret), and so is a
 * push token; an email address is what it looks like. `signing_secret` is
 * always sealed. The re-encrypt sweep (`src/admin/reencrypt-secrets.ts`)
 * re-seals both columns under the current key version.
 */
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  decryptSecret,
  encryptSecret,
  isSealedEnvelope,
} from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  backupTarget,
  grant,
  notification,
  notificationChannel,
  notificationDelivery,
  notificationRule,
  notificationWatermark,
  organization,
  project,
  server,
  team,
  teammate,
  user,
} from '../../db/schema.ts'
import {
  DEFAULT_TIME_ZONE,
  type NotificationDigestCadence,
  type QuietHours,
  usableTimeZone,
} from './windows.ts'
import {
  NOTIFICATION_RULE_ANY_EVENT,
  type NotificationContext,
  type NotificationEvent,
  type NotificationSeverity,
  severityAtLeast,
} from './events.ts'
import type { NotificationAttemptReason } from './vocabulary.ts'

/** Shared channels only: personal channels are decided by preferences (`emit.ts`). */
function sharedChannelFilter(organizationId: string | null) {
  if (!organizationId) return eq(notificationChannel.scope, 'instance')
  return or(
    eq(notificationChannel.scope, 'instance'),
    eq(notificationChannel.organizationId, organizationId)
  )
}

export const NOTIFICATION_CHANNEL_SCOPES = ['instance', 'organization', 'user'] as const
export type NotificationChannelScope = (typeof NOTIFICATION_CHANNEL_SCOPES)[number]

export const NOTIFICATION_CHANNEL_KINDS = [
  'email',
  'webhook',
  'slack',
  'discord',
  'telegram',
  'push',
] as const
export type NotificationChannelKind = (typeof NOTIFICATION_CHANNEL_KINDS)[number]

export const NOTIFICATION_DELIVERY_STATUSES = [
  'pending',
  'sent',
  'failed',
  'abandoned',
  'held',
  'suppressed',
] as const
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number]

/** Kinds whose address is a credential and is therefore stored sealed. */
export function channelAddressIsSecret(kind: NotificationChannelKind): boolean {
  return kind !== 'email'
}

/** After this many failed attempts a delivery is abandoned, not retried. */
export const NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 5

/** Backoff between attempts: 1, 5, 25, 125 minutes — bounded by the cap above. */
export function nextAttemptDelayMs(attempts: number): number {
  return 60_000 * 5 ** Math.max(0, Math.min(attempts - 1, 3))
}

export type NotificationChannelRecord = {
  id: string
  scope: NotificationChannelScope
  organizationId: string | null
  userId: string | null
  kind: NotificationChannelKind
  label: string
  /** Stored form: sealed for secret kinds. Use {@link resolveChannelAddress} to read it. */
  address: string
  signingSecret: string | null
  verifiedAt: string | null
  disabledAt: string | null
  createdAt: string
  /** null = every event is sent as it happens. */
  digestCadence: NotificationDigestCadence | null
  /** null = no quiet hours. */
  quiet: QuietHours | null
  /** The built-in account email channel: follows the sign-in address, cannot be deleted. */
  isPrimary: boolean
}

export type NotificationRuleRecord = {
  id: string
  channelId: string
  event: string
  minSeverity: NotificationSeverity
}

export function asChannel(row: typeof notificationChannel.$inferSelect): NotificationChannelRecord {
  return {
    id: row.id,
    scope: row.scope as NotificationChannelScope,
    organizationId: row.organizationId,
    userId: row.userId,
    kind: row.kind as NotificationChannelKind,
    label: row.label,
    address: row.address,
    signingSecret: row.signingSecret,
    verifiedAt: row.verifiedAt,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
    digestCadence: row.digestCadence as NotificationDigestCadence | null,
    quiet:
      row.quietStartMinute !== null && row.quietEndMinute !== null
        ? { startMinute: row.quietStartMinute, endMinute: row.quietEndMinute }
        : null,
    isPrimary: row.isPrimary,
  }
}

export type CreateChannelInput = {
  scope: NotificationChannelScope
  organizationId?: string | null
  userId?: string | null
  kind: NotificationChannelKind
  label: string
  /** Plain; sealed here when the kind calls for it. */
  address: string
  /** Plain; always sealed. */
  signingSecret?: string | null
  createdByUserId?: string | null
  verifiedAt?: string | null
}

export async function createNotificationChannel(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  input: CreateChannelInput
): Promise<NotificationChannelRecord> {
  const sealed = channelAddressIsSecret(input.kind) || input.signingSecret
  if (sealed && !secrets) {
    throw new Error('data encryption secrets are required to store a notification channel address')
  }
  const address = channelAddressIsSecret(input.kind)
    ? await encryptSecret(secrets!, input.address)
    : input.address
  const signingSecret = input.signingSecret
    ? await encryptSecret(secrets!, input.signingSecret)
    : null
  const [row] = await db
    .insert(notificationChannel)
    .values({
      scope: input.scope,
      organizationId: input.organizationId ?? null,
      userId: input.userId ?? null,
      kind: input.kind,
      label: input.label,
      address,
      signingSecret,
      createdByUserId: input.createdByUserId ?? null,
      verifiedAt: input.verifiedAt ?? null,
    })
    .returning()
  if (!row) throw new Error('notification channel insert returned no row')
  return asChannel(row)
}

/** The plain address, whatever form it is stored in; null when it cannot be unsealed. */
export async function resolveChannelAddress(
  secrets: DerivedSecretsConfig | undefined,
  channel: Pick<NotificationChannelRecord, 'kind' | 'address'>
): Promise<string | null> {
  if (!channelAddressIsSecret(channel.kind) || !isSealedEnvelope(channel.address)) {
    return channel.address
  }
  if (!secrets) return null
  try {
    return await decryptSecret(secrets, channel.address)
  } catch {
    return null
  }
}

export async function resolveChannelSigningSecret(
  secrets: DerivedSecretsConfig | undefined,
  channel: Pick<NotificationChannelRecord, 'signingSecret'>
): Promise<string | null> {
  if (!channel.signingSecret) return null
  if (!isSealedEnvelope(channel.signingSecret)) return channel.signingSecret
  if (!secrets) return null
  try {
    return await decryptSecret(secrets, channel.signingSecret)
  } catch {
    return null
  }
}

/** What a settings screen renders: never the address of a secret kind, only its origin or a mask. */
export function describeChannelAddress(
  kind: NotificationChannelKind,
  plainAddress: string | null
): string {
  if (plainAddress === null) return '(unreadable)'
  if (!channelAddressIsSecret(kind)) return plainAddress
  if (kind === 'webhook' || kind === 'slack' || kind === 'discord') {
    try {
      return new URL(plainAddress).origin
    } catch {
      return '(invalid URL)'
    }
  }
  // Telegram chat ids and push tokens: show the tail so two can be told apart.
  return plainAddress.length > 6 ? `…${plainAddress.slice(-4)}` : '…'
}

export async function listChannelsForUser(
  db: Db,
  userId: string
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.userId, userId))
    .orderBy(desc(notificationChannel.createdAt))
  return rows.map(asChannel)
}

export async function listChannelsForOrganization(
  db: Db,
  organizationId: string
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.organizationId, organizationId))
    .orderBy(desc(notificationChannel.createdAt))
  return rows.map(asChannel)
}

export async function listInstanceChannels(db: Db): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.scope, 'instance'))
    .orderBy(desc(notificationChannel.createdAt))
  return rows.map(asChannel)
}

export async function getChannel(db: Db, id: string): Promise<NotificationChannelRecord | null> {
  const [row] = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.id, id))
    .limit(1)
  return row ? asChannel(row) : null
}

export async function deleteChannel(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(notificationChannel)
    .where(eq(notificationChannel.id, id))
    .returning({ id: notificationChannel.id })
  return rows.length > 0
}

export async function updateChannelLabel(db: Db, id: string, label: string): Promise<void> {
  await db.update(notificationChannel).set({ label }).where(eq(notificationChannel.id, id))
}

export async function setChannelDisabled(db: Db, id: string, disabled: boolean): Promise<void> {
  await db
    .update(notificationChannel)
    .set({ disabledAt: disabled ? sql`now()` : null })
    .where(eq(notificationChannel.id, id))
}

/** Digest cadence and quiet hours for one channel; `null` clears either. Replaces both together. */
export async function setChannelHoldSettings(
  db: Db,
  id: string,
  settings: {
    digestCadence: NotificationDigestCadence | null
    quiet: QuietHours | null
  }
): Promise<void> {
  await db
    .update(notificationChannel)
    .set({
      digestCadence: settings.digestCadence,
      quietStartMinute: settings.quiet?.startMinute ?? null,
      quietEndMinute: settings.quiet?.endMinute ?? null,
    })
    .where(eq(notificationChannel.id, id))
}

/** The IANA zone a person chose, or null (read as UTC). */
export async function getUserTimeZone(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ timeZone: user.timeZone })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return row?.timeZone ?? null
}

export async function setUserTimeZone(
  db: Db,
  userId: string,
  timeZone: string | null
): Promise<void> {
  await db.update(user).set({ timeZone }).where(eq(user.id, userId))
}

/** The organization-wide default zone (`options.defaultServerTimezone`), or null. */
async function organizationTimeZones(
  db: Db,
  organizationIds: readonly string[]
): Promise<Map<string, string | null>> {
  if (organizationIds.length === 0) return new Map()
  const rows = await db
    .select({ id: organization.id, options: organization.options })
    .from(organization)
    .where(inArray(organization.id, [...organizationIds]))
  return new Map(
    rows.map((r) => {
      const zone = (r.options as { defaultServerTimezone?: unknown } | null)?.defaultServerTimezone
      return [r.id, typeof zone === 'string' ? zone : null]
    })
  )
}

/**
 * The zone each channel's quiet hours and digest windows are read in: a
 * personal channel uses its owner's zone, an organization channel the
 * organization default, an instance channel UTC; anything unset or unusable is
 * UTC.
 */
export async function channelTimeZones(
  db: Db,
  channels: ReadonlyArray<
    Pick<NotificationChannelRecord, 'id' | 'scope' | 'userId' | 'organizationId'>
  >
): Promise<Map<string, string>> {
  const userIds = channels.flatMap((c) => (c.scope === 'user' && c.userId ? [c.userId] : []))
  const orgIds = channels.flatMap((c) =>
    c.scope === 'organization' && c.organizationId ? [c.organizationId] : []
  )
  const [users, orgs] = await Promise.all([
    userIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: user.id, timeZone: user.timeZone })
          .from(user)
          .where(inArray(user.id, userIds)),
    organizationTimeZones(db, orgIds),
  ])
  const byUser = new Map(users.map((u) => [u.id, u.timeZone]))
  const zoneOf = (c: (typeof channels)[number]): string | null | undefined => {
    if (c.scope === 'user') return byUser.get(c.userId ?? '')
    if (c.scope === 'organization') return orgs.get(c.organizationId ?? '')
    return null
  }
  return new Map(channels.map((c) => [c.id, usableTimeZone(zoneOf(c) ?? DEFAULT_TIME_ZONE)]))
}

export async function listRulesForChannel(
  db: Db,
  channelId: string
): Promise<NotificationRuleRecord[]> {
  const rows = await db
    .select()
    .from(notificationRule)
    .where(eq(notificationRule.channelId, channelId))
  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    event: r.event,
    minSeverity: r.minSeverity as NotificationSeverity,
  }))
}

/** Replace a channel's rules wholesale — the preferences screen saves the matrix, not a diff. */
export async function replaceRulesForChannel(
  db: Db,
  channelId: string,
  rules: ReadonlyArray<{ event: string; minSeverity: NotificationSeverity }>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(notificationRule).where(eq(notificationRule.channelId, channelId))
    if (rules.length > 0) {
      await tx.insert(notificationRule).values(
        rules.map((r) => ({
          channelId,
          event: r.event,
          minSeverity: r.minSeverity,
        }))
      )
    }
  })
}

/**
 * Every enabled shared channel a rule routes this event to: the
 * organization's own channels, plus instance channels for everything (as
 * before). Personal channels are not routed by rules any more; preferences
 * decide them (`emit.ts`). A rule names `*`, one code (the older `event`
 * column or `topic_code`), or one category; a disabled or muted route sends
 * nothing.
 */
export async function channelsForEvent(
  db: Db,
  event: NotificationEvent,
  severity: NotificationSeverity,
  organizationId: string | null,
  categoryCode: string | null = null
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select({ channel: notificationChannel, rule: notificationRule })
    .from(notificationRule)
    .innerJoin(notificationChannel, eq(notificationRule.channelId, notificationChannel.id))
    .where(
      and(
        isNull(notificationChannel.disabledAt),
        ne(notificationChannel.scope, 'user'),
        sharedChannelFilter(organizationId),
        eq(notificationRule.isEnabled, true),
        or(isNull(notificationRule.endsAt), sql`${notificationRule.endsAt} <= now()`),
        or(
          eq(notificationRule.event, NOTIFICATION_RULE_ANY_EVENT),
          eq(notificationRule.event, event),
          eq(notificationRule.topicCode, event),
          categoryCode ? eq(notificationRule.categoryCode, categoryCode) : undefined
        )
      )
    )
  const seen = new Set<string>()
  const out: NotificationChannelRecord[] = []
  for (const { channel, rule } of rows) {
    if (seen.has(channel.id)) continue
    if (!severityAtLeast(severity, rule.minSeverity as NotificationSeverity)) {
      continue
    }
    seen.add(channel.id)
    out.push(asChannel(channel))
  }
  return out
}

export async function organizationName(db: Db, organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  return row?.name ?? null
}

/**
 * Everyone holding `organization:own` or `organization:manage` on the
 * organization — directly, through a team they belong to, or through the
 * organization itself as the subject. The inbox audience for events that
 * mirror the owner-only audit trail (decided 2026-09-18): a plain teammate
 * does not learn every grant change from the bell.
 */
export async function organizationManagerIds(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ actorType: grant.actorType, actorId: grant.actorId })
    .from(grant)
    .where(
      and(
        eq(grant.entityType, 'organization'),
        eq(grant.entityId, organizationId),
        inArray(grant.permission, ['organization:own', 'organization:manage'])
      )
    )
  const ids = new Set<string>()
  const teamIds: string[] = []
  let everyone = false
  for (const row of rows) {
    if (row.actorType === 'user') ids.add(row.actorId)
    else if (row.actorType === 'team') teamIds.push(row.actorId)
    else if (row.actorType === 'organization') everyone = true
  }
  if (everyone) return await organizationMemberIds(db, organizationId)
  if (teamIds.length > 0) {
    const members = await db
      .selectDistinct({ userId: teammate.userId })
      .from(teammate)
      .where(inArray(teammate.teamId, teamIds))
    for (const m of members) ids.add(m.userId)
  }
  // No administrator bypass (owner decision 2026-11-06): an administrator hears
  // an organization they belong to, or every one once they switch that on.
  return [...ids]
}

/** The account emails of everyone in the organization — what an organization email channel may name. */
export async function organizationMemberEmails(
  db: Db,
  organizationId: string
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ email: user.email })
    .from(teammate)
    .innerJoin(team, eq(teammate.teamId, team.id))
    .innerJoin(user, eq(teammate.userId, user.id))
    .where(eq(team.organizationId, organizationId))
  return new Set(rows.map((r) => r.email.toLowerCase()))
}

/** Everyone who belongs to the organization through a team — the inbox fan-out. */
export async function organizationMemberIds(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: teammate.userId })
    .from(teammate)
    .innerJoin(team, eq(teammate.teamId, team.id))
    .where(eq(team.organizationId, organizationId))
  return rows.map((r) => r.userId)
}

/** Instance administrators — the inbox fan-out for an instance-scoped event. */
export async function instanceAdminIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.role, ['admin', 'superadmin']))
  return rows.map((r) => r.id)
}

export type NotificationInsert = {
  userId: string
  organizationId: string | null
  event: NotificationEvent
  severity: NotificationSeverity
  title: string
  body: string | null
  targetType?: string | null
  targetId?: string | null
  context?: NotificationContext | null
  eventId?: string | null
  projectId?: string | null
  environmentId?: string | null
  serviceId?: string | null
  serverId?: string | null
  destinationId?: string | null
}

/** One inbox row per event and person; a re-run fan-out writes nothing twice. */
export async function insertNotifications(db: Db, rows: NotificationInsert[]): Promise<number> {
  if (rows.length === 0) return 0
  const inserted = await db
    .insert(notification)
    .values(
      rows.map((r) => ({
        userId: r.userId,
        organizationId: r.organizationId,
        // The older `event` column keeps being written beside `topic_code`
        // until the reset drops it.
        event: r.event,
        topicCode: r.event,
        severity: r.severity,
        title: r.title,
        body: r.body,
        targetType: r.targetType ?? null,
        targetId: r.targetId ?? null,
        context: r.context ?? null,
        eventId: r.eventId ?? null,
        projectId: r.projectId ?? null,
        environmentId: r.environmentId ?? null,
        serviceId: r.serviceId ?? null,
        serverId: r.serverId ?? null,
        destinationId: r.destinationId ?? null,
      }))
    )
    .onConflictDoNothing()
    .returning({ id: notification.id })
  return inserted.length
}

export type NotificationRecord = {
  id: string
  createdAt: string
  organizationId: string | null
  event: string
  severity: NotificationSeverity
  title: string
  body: string | null
  targetType: string | null
  targetId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  serverId: string | null
  destinationId: string | null
  readAt: string | null
  /** The thing the row is about is gone; the row reads on, its link does not. */
  targetDeleted: boolean
}

/**
 * Inbox rows a person may still see: install events, and organization events
 * only while they belong to that organization (or, as an administrator, have
 * chosen to hear every organization). A former member's old rows stay hidden
 * until retention removes them.
 */
function visibleToUser(userId: string) {
  return sql`(${notification.organizationId} IS NULL
    OR EXISTS (
      SELECT 1 FROM ${teammate} tm JOIN ${team} t ON t.id = tm.team_id
      WHERE tm.user_id = ${userId}::uuid AND t.organization_id = ${notification.organizationId}
    )
    OR EXISTS (
      SELECT 1 FROM ${user} u WHERE u.id = ${userId}::uuid
        AND u.role IN ('admin', 'superadmin') AND u.is_all_organizations_notified
    ))`
}

/** The person's mark-all-read time, or the epoch. */
function readThrough(userId: string) {
  return sql`coalesce((SELECT w.read_through FROM ${notificationWatermark} w
    WHERE w.user_id = ${userId}::uuid AND w.organization_id IS NULL), '-infinity'::timestamptz)`
}

/** True when the row's target (server or backup target) no longer exists. */
const targetDeletedSql = sql<boolean>`(
  (${notification.serverId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${server} s WHERE s.id = ${notification.serverId}))
  OR (${notification.destinationId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${backupTarget} d WHERE d.id = ${notification.destinationId}))
  OR (${notification.projectId} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${project} p WHERE p.id = ${notification.projectId}))
  OR (${notification.serverId} IS NULL AND ${notification.targetType} = 'server' AND ${notification.targetId} IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${server} s WHERE s.id = ${notification.targetId}))
)`

export async function listNotificationsForUser(
  db: Db,
  userId: string,
  opts: { limit?: number; before?: string } = {}
): Promise<NotificationRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)
  const rows = await db
    .select({
      row: notification,
      watermark: sql<string | null>`nullif(${readThrough(userId)}, '-infinity'::timestamptz)`,
      targetDeleted: targetDeletedSql,
    })
    .from(notification)
    .where(
      and(
        eq(notification.userId, userId),
        isNull(notification.dismissedAt),
        visibleToUser(userId),
        opts.before ? lt(notification.createdAt, opts.before) : undefined
      )
    )
    .orderBy(desc(notification.createdAt))
    .limit(limit)
  return rows.map(({ row: r, watermark, targetDeleted }) => ({
    id: r.id,
    createdAt: r.createdAt,
    organizationId: r.organizationId,
    event: r.topicCode ?? r.event,
    severity: r.severity as NotificationSeverity,
    title: r.title,
    body: r.body,
    targetType: r.targetType,
    targetId: r.targetId,
    projectId: r.projectId,
    environmentId: r.environmentId,
    serviceId: r.serviceId,
    serverId: r.serverId,
    destinationId: r.destinationId,
    readAt:
      r.readAt ??
      (watermark !== null && Date.parse(r.createdAt) <= Date.parse(watermark) ? watermark : null),
    targetDeleted: targetDeleted === true,
  }))
}

/** Unread rows the badge counts, capped: the bell shows 99+ past that. */
export const UNREAD_COUNT_CAP = 100

export async function countUnreadForUser(db: Db, userId: string): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS count FROM (
      SELECT 1 FROM ${notification}
      WHERE ${notification.userId} = ${userId}::uuid
        AND ${notification.readAt} IS NULL
        AND ${notification.dismissedAt} IS NULL
        AND ${notification.createdAt} > ${readThrough(userId)}
        AND ${visibleToUser(userId)}
      LIMIT ${UNREAD_COUNT_CAP}
    ) capped
  `)
  const first = (rows as unknown as Array<{ count: number }>)[0]
  return first?.count ?? 0
}

/**
 * Cancel the held (quiet hours or digest) email copies of what the person has
 * now read in the bell (owner decision 2026-11-06). Only their own copies (a
 * shared channel's copy is the team's and stays), only email (a held chat or
 * webhook copy still goes out), and only for events that have a bell row for
 * them: with `'all'`, every event in their bell, never a held copy of an
 * event the bell did not show (the bell off and an email digest on is a legal
 * setup).
 */
async function cancelHeldCopies(db: Db, userId: string, eventIds: readonly string[] | 'all') {
  if (eventIds !== 'all' && eventIds.length === 0) return
  const inBell = db
    .select({ eventId: notification.eventId })
    .from(notification)
    .where(and(eq(notification.userId, userId), isNotNull(notification.eventId)))
  const emailChannels = db
    .select({ id: notificationChannel.id })
    .from(notificationChannel)
    .where(and(eq(notificationChannel.userId, userId), eq(notificationChannel.kind, 'email')))
  await db
    .update(notificationDelivery)
    .set({ status: 'abandoned', reason: 'read_in_app', nextAttemptAt: null })
    .where(
      and(
        eq(notificationDelivery.userId, userId),
        eq(notificationDelivery.status, 'held'),
        inArray(notificationDelivery.channelId, emailChannels),
        eventIds === 'all'
          ? inArray(notificationDelivery.eventId, inBell)
          : inArray(notificationDelivery.eventId, [...eventIds])
      )
    )
}

/** Most ids one mark-read request may name. */
export const MARK_READ_MAX_IDS = 200

/**
 * Mark the given rows read for this person, or, with no ids, everything up to
 * now: one watermark row instead of rewriting every unread row. Either way,
 * held email copies of what was read are cancelled.
 */
export async function markNotificationsRead(
  db: Db,
  userId: string,
  ids: readonly string[]
): Promise<number> {
  if (ids.length === 0) {
    await db
      .insert(notificationWatermark)
      .values({ userId, organizationId: null, readThrough: sql`now()` })
      .onConflictDoUpdate({
        target: [notificationWatermark.userId, notificationWatermark.organizationId],
        set: { readThrough: sql`now()`, updatedAt: sql`now()` },
      })
    await cancelHeldCopies(db, userId, 'all')
    return 0
  }
  const rows = await db
    .update(notification)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notification.userId, userId),
        isNull(notification.readAt),
        inArray(notification.id, ids.slice(0, MARK_READ_MAX_IDS))
      )
    )
    .returning({ id: notification.id, eventId: notification.eventId })
  await cancelHeldCopies(
    db,
    userId,
    rows.flatMap((r) => (r.eventId ? [r.eventId] : []))
  )
  return rows.length
}

export async function dismissNotification(db: Db, userId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(notification)
    .set({ dismissedAt: sql`now()`, readAt: sql`coalesce(read_at, now())` })
    .where(and(eq(notification.userId, userId), eq(notification.id, id)))
    .returning({ id: notification.id, eventId: notification.eventId })
  await cancelHeldCopies(
    db,
    userId,
    rows.flatMap((r) => (r.eventId ? [r.eventId] : []))
  )
  return rows.length > 0
}

export type DeliveryPayload = {
  event: NotificationEvent
  severity: NotificationSeverity
  title: string
  body: string | null
  organizationId: string | null
  /** Denormalized for the message; null for an instance-scoped event. */
  organizationName: string | null
  targetType: string | null
  targetId: string | null
  context: NotificationContext
  /** ISO time the event happened. */
  at: string
  /** The `event` row; absent on rows written before it existed. */
  eventId?: string | null
  /** The catalogue category, for unsubscribe links and filtering headers. */
  categoryCode?: string | null
  projectId?: string | null
  environmentId?: string | null
  serviceId?: string | null
  serverId?: string | null
  destinationId?: string | null
}

export type NotificationDeliveryRecord = {
  id: string
  channelId: string
  organizationId: string | null
  event: NotificationEvent
  severity: NotificationSeverity
  payload: DeliveryPayload
  status: NotificationDeliveryStatus
  attempts: number
  /** The person a personal copy is for; null for a shared channel. */
  userId: string | null
  eventId: string | null
}

/**
 * How long the retry sweep leaves a fresh row to the inline attempt. The
 * inline send is bounded at 5 s per channel; a sweep tick fires every 60 s on
 * both runtimes. Two minutes means the sweep only ever reaches a row whose
 * inline attempt never came back to record itself — a Worker killed
 * mid-send, the case the ledger-first design exists for — and never races a
 * slow one into a double send.
 */
export const INLINE_ATTEMPT_GRACE_MS = 2 * 60_000

/** One copy to write: the channel, who it is for, and whether it waits or is not sent at all. */
export type LedgerCopy = {
  channelId: string
  userId?: string | null
  /** `held` waits for a window; `suppressed` / `abandoned` are recorded and never sent. */
  status?: 'pending' | 'held' | 'suppressed' | 'abandoned'
  reason?: NotificationAttemptReason | null
}

function ledgerRow(copy: LedgerCopy, payload: DeliveryPayload) {
  const base = {
    channelId: copy.channelId,
    userId: copy.userId ?? null,
    eventId: payload.eventId ?? null,
    topicCode: payload.event,
    organizationId: payload.organizationId,
    event: payload.event,
    severity: payload.severity,
    payload,
    attempts: 0,
    reason: copy.reason ?? null,
  }
  const status = copy.status ?? 'pending'
  if (status === 'held') {
    // Nothing retries a held row (no retry time); it is dated by the event, so
    // the window that closes after the event is the one that carries it.
    return {
      ...base,
      status: 'held',
      nextAttemptAt: null,
      createdAt: payload.at,
    }
  }
  if (status !== 'pending') {
    return { ...base, status, nextAttemptAt: null }
  }
  return {
    ...base,
    status: 'pending',
    nextAttemptAt: new Date(Date.now() + INLINE_ATTEMPT_GRACE_MS).toISOString(),
  }
}

/**
 * Write the ledger rows first — a crash between here and the send leaves a
 * pending row, not silence. A held row waits for the digest sweep; a
 * suppressed or abandoned row records why the copy was not sent. One copy per
 * event, person and channel (`uniq_attempt_copy`): a re-run fan-out writes
 * nothing twice.
 */
export async function insertDeliveries(
  db: Db,
  copies: readonly LedgerCopy[],
  payload: DeliveryPayload
): Promise<NotificationDeliveryRecord[]> {
  if (copies.length === 0) return []
  const rows = await db
    .insert(notificationDelivery)
    .values(copies.map((copy) => ledgerRow(copy, payload)))
    .onConflictDoNothing()
    .returning()
  return rows.map(asDelivery)
}

/** Shared-channel copies by id, with `held` for the ids in `heldChannelIds`. */
export async function insertPendingDeliveries(
  db: Db,
  channelIds: readonly string[],
  payload: DeliveryPayload,
  heldChannelIds: ReadonlySet<string> = new Set()
): Promise<NotificationDeliveryRecord[]> {
  return await insertDeliveries(
    db,
    channelIds.map((channelId) => ({
      channelId,
      status: heldChannelIds.has(channelId) ? 'held' : 'pending',
    })),
    payload
  )
}

function asDelivery(row: typeof notificationDelivery.$inferSelect): NotificationDeliveryRecord {
  return {
    id: row.id,
    channelId: row.channelId,
    organizationId: row.organizationId,
    event: row.event as NotificationEvent,
    severity: row.severity as NotificationSeverity,
    payload: row.payload as DeliveryPayload,
    status: row.status as NotificationDeliveryStatus,
    attempts: row.attempts,
    userId: row.userId,
    eventId: row.eventId,
  }
}

/** A copy dropped because its address is suppressed reads `suppressed`; any other drop is `abandoned`. */
function droppedStatus(reason: NotificationAttemptReason): 'suppressed' | 'abandoned' {
  return reason === 'bounced' ? 'suppressed' : 'abandoned'
}

/**
 * Record one attempt's outcome. The counter is bumped in SQL, not read then
 * written, so two recorders for one row can never both count as attempt 1;
 * the backoff and the abandon decision come from the value the update returns.
 */
export async function recordDeliveryAttempt(
  db: Db,
  id: string,
  outcome: { ok: true } | { ok: false; error: string; drop?: NotificationAttemptReason }
): Promise<void> {
  if (!outcome.ok && outcome.drop) {
    // Not a failure to retry: the copy must not go out (no access any more,
    // its scope is gone, the address is suppressed).
    await db
      .update(notificationDelivery)
      .set({
        status: droppedStatus(outcome.drop),
        reason: outcome.drop,
        nextAttemptAt: null,
        lastError: outcome.error.slice(0, 200),
      })
      .where(eq(notificationDelivery.id, id))
    return
  }
  if (outcome.ok) {
    await db
      .update(notificationDelivery)
      .set({
        status: 'sent',
        attempts: sql`${notificationDelivery.attempts} + 1`,
        sentAt: sql`now()`,
        nextAttemptAt: null,
        lastError: null,
      })
      .where(eq(notificationDelivery.id, id))
    return
  }
  const [row] = await db
    .update(notificationDelivery)
    .set({
      status: 'failed',
      attempts: sql`${notificationDelivery.attempts} + 1`,
      lastError: outcome.error.slice(0, 200),
    })
    .where(eq(notificationDelivery.id, id))
    .returning({ attempts: notificationDelivery.attempts })
  const attempts = row?.attempts ?? NOTIFICATION_DELIVERY_MAX_ATTEMPTS
  const abandoned = attempts >= NOTIFICATION_DELIVERY_MAX_ATTEMPTS
  await db
    .update(notificationDelivery)
    .set({
      status: abandoned ? 'abandoned' : 'failed',
      nextAttemptAt: abandoned
        ? null
        : new Date(Date.now() + nextAttemptDelayMs(attempts)).toISOString(),
    })
    .where(eq(notificationDelivery.id, id))
}

/**
 * Take the failed deliveries whose retry time has come — the maintenance
 * tick's batch — claiming them in the same statement.
 *
 * Only rows this sweep can actually send are selected: the channel is not
 * paused, is not push (the Expo transport owns those rows), and is email only
 * when the tick has an email queue and the address is verified. A row the
 * sweep would skip is never picked, so rows for a paused channel (which wait
 * for it to resume) cannot fill the batch and starve every other channel.
 *
 * Claiming moves each row's retry time out by the inline-attempt grace
 * (`FOR UPDATE SKIP LOCKED`, the way {@link claimHeldDeliveries} does), so two
 * sweeps that overlap — two instances, or one tick running past the next —
 * never both get a row. The attempt that follows writes the real next retry
 * time; a sweeper that dies mid-send leaves rows that come due again after the
 * grace.
 */
export async function claimDueDeliveries(
  db: Db,
  limit = 50,
  opts: { includeEmail?: boolean } = {}
): Promise<NotificationDeliveryRecord[]> {
  const now = new Date().toISOString()
  const kindFilter = opts.includeEmail
    ? or(
        and(eq(notificationChannel.kind, 'email'), emailChannelIsSendable()),
        notInArray(notificationChannel.kind, ['email', 'push'])
      )
    : notInArray(notificationChannel.kind, ['email', 'push'])
  const dueStatus = and(
    inArray(notificationDelivery.status, ['pending', 'failed']),
    lt(notificationDelivery.nextAttemptAt, now)
  )
  const candidates = db
    .select({ id: notificationDelivery.id })
    .from(notificationDelivery)
    .innerJoin(notificationChannel, eq(notificationDelivery.channelId, notificationChannel.id))
    .where(and(dueStatus, isNull(notificationChannel.disabledAt), kindFilter))
    .orderBy(notificationDelivery.nextAttemptAt)
    .limit(limit)
    .for('update', { of: notificationDelivery, skipLocked: true })
  const rows = await db
    .update(notificationDelivery)
    .set({ nextAttemptAt: new Date(Date.now() + INLINE_ATTEMPT_GRACE_MS).toISOString() })
    .where(and(dueStatus, inArray(notificationDelivery.id, candidates)))
    .returning()
  return rows.map(asDelivery)
}

/**
 * An email channel the sweeps may pick: a confirmed address, or the built-in
 * account email channel, whose address and verification are the account's and
 * are checked at send (`deliveryAddress`).
 */
function emailChannelIsSendable() {
  return or(isNotNull(notificationChannel.verifiedAt), eq(notificationChannel.isPrimary, true))
}

/**
 * Enabled channels that have at least one held delivery — the digest sweep's batch.
 * Chat and webhook channels keep their addresses sealed, so a tick without the
 * data-encryption secrets leaves them out (`includeChat: false`): their rows
 * stay held, with no attempt counted, until a tick that has the secrets.
 */
export async function listChannelsWithHeldDeliveries(
  db: Db,
  limit = 50,
  opts: { includeEmail?: boolean; includeChat?: boolean } = {}
): Promise<NotificationChannelRecord[]> {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(
      and(
        // Chat and webhook channels need nothing but the sweep; an email
        // channel also needs a verified address and a tick with a mail queue.
        opts.includeEmail
          ? or(ne(notificationChannel.kind, 'email'), emailChannelIsSendable())
          : ne(notificationChannel.kind, 'email'),
        ne(notificationChannel.kind, 'push'),
        opts.includeChat === false ? eq(notificationChannel.kind, 'email') : undefined,
        isNull(notificationChannel.disabledAt),
        inArray(
          notificationChannel.id,
          db
            .select({ id: notificationDelivery.channelId })
            .from(notificationDelivery)
            .where(eq(notificationDelivery.status, 'held'))
        )
      )
    )
    .orderBy(notificationChannel.createdAt)
    .limit(limit)
  return rows.map(asChannel)
}

/**
 * Take the held deliveries a window has closed on, atomically: the rows move to
 * `pending` with the inline-attempt grace on their retry time, so two sweeps
 * racing for one channel never both get a row (the loser matches nothing), and
 * a sweeper that dies mid-send leaves rows the retry sweep will still deliver.
 */
export async function claimHeldDeliveries(
  db: Db,
  channelId: string,
  createdAtOrBefore: string,
  limit: number
): Promise<NotificationDeliveryRecord[]> {
  const candidates = db
    .select({ id: notificationDelivery.id })
    .from(notificationDelivery)
    .where(
      and(
        eq(notificationDelivery.channelId, channelId),
        eq(notificationDelivery.status, 'held'),
        lte(notificationDelivery.createdAt, createdAtOrBefore)
      )
    )
    .orderBy(notificationDelivery.createdAt)
    .limit(limit)
    .for('update', { skipLocked: true })
  const rows = await db
    .update(notificationDelivery)
    .set({
      status: 'pending',
      nextAttemptAt: new Date(Date.now() + INLINE_ATTEMPT_GRACE_MS).toISOString(),
    })
    .where(
      and(eq(notificationDelivery.status, 'held'), inArray(notificationDelivery.id, candidates))
    )
    .returning()
  return rows.map(asDelivery)
}

/**
 * Close out claimed rows after the one digest email: sent on success; on failure
 * back to `held` for the next sweep, `abandoned` once a row has failed the cap.
 */
export async function finishDigestDeliveries(
  db: Db,
  ids: readonly string[],
  outcome: { ok: true } | { ok: false; error: string; drop?: NotificationAttemptReason }
): Promise<void> {
  if (ids.length === 0) return
  const where = and(
    inArray(notificationDelivery.id, [...ids]),
    eq(notificationDelivery.status, 'pending')
  )
  if (!outcome.ok && outcome.drop) {
    await db
      .update(notificationDelivery)
      .set({ status: droppedStatus(outcome.drop), reason: outcome.drop, nextAttemptAt: null })
      .where(where)
    return
  }
  if (outcome.ok) {
    await db
      .update(notificationDelivery)
      .set({
        status: 'sent',
        attempts: sql`${notificationDelivery.attempts} + 1`,
        sentAt: sql`now()`,
        nextAttemptAt: null,
        lastError: null,
      })
      .where(where)
    return
  }
  await db
    .update(notificationDelivery)
    .set({
      status: sql`case when ${notificationDelivery.attempts} + 1 >= ${NOTIFICATION_DELIVERY_MAX_ATTEMPTS} then 'abandoned' else 'held' end`,
      attempts: sql`${notificationDelivery.attempts} + 1`,
      nextAttemptAt: null,
      lastError: outcome.error.slice(0, 200),
    })
    .where(where)
}

/** Deliveries newer than `since` for one channel — what a channel's detail row shows. */
export async function listRecentDeliveriesForChannel(
  db: Db,
  channelId: string,
  since: string
): Promise<NotificationDeliveryRecord[]> {
  const rows = await db
    .select()
    .from(notificationDelivery)
    .where(
      and(eq(notificationDelivery.channelId, channelId), gt(notificationDelivery.createdAt, since))
    )
    .orderBy(desc(notificationDelivery.createdAt))
    .limit(20)
  return rows.map(asDelivery)
}

/** The label the operator's instance-wide alert webhook carries once folded into a channel. */
export const OPERATOR_WEBHOOK_LABEL = 'Operator alert webhook'

/** The instance webhook channel the legacy `ALERT_WEBHOOK_URL` setting became, if any. */
export async function getOperatorWebhookChannel(db: Db): Promise<NotificationChannelRecord | null> {
  const [row] = await db
    .select()
    .from(notificationChannel)
    .where(
      and(
        eq(notificationChannel.scope, 'instance'),
        eq(notificationChannel.kind, 'webhook'),
        eq(notificationChannel.label, OPERATOR_WEBHOOK_LABEL)
      )
    )
    .orderBy(notificationChannel.createdAt)
    .limit(1)
  return row ? asChannel(row) : null
}

/** Replace a channel's sealed address (already-validated plain input). */
export async function updateChannelAddress(
  db: Db,
  secrets: DerivedSecretsConfig,
  id: string,
  kind: NotificationChannelKind,
  plainAddress: string
): Promise<void> {
  const address = channelAddressIsSecret(kind)
    ? await encryptSecret(secrets, plainAddress)
    : plainAddress
  await db.update(notificationChannel).set({ address }).where(eq(notificationChannel.id, id))
}

/** The account emails of every instance administrator — what an instance email channel may name. */
export async function instanceAdminEmails(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(inArray(user.role, ['admin', 'superadmin']))
  return new Set(rows.map((r) => r.email.toLowerCase()))
}
