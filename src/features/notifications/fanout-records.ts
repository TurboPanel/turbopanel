/**
 * Reads and writes the fan-out needs beyond the four original tables: the
 * catalog, the `event` outbox, recipients by audience, preference rows,
 * personal channels (including the built-in account email), and suppression.
 *
 * Recipients are decided at send time from who belongs now (owner decisions
 * 2026-11-06): members are `teammate` rows of the organization; managers hold
 * `organization:own` or `organization:manage` directly, through a team or
 * through the organization itself; an install administrator hears an
 * organization only when they belong to it or have switched on
 * `user.is_all_organizations_notified`.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  environment,
  grant,
  notificationChannel,
  notificationEvent,
  notificationPreference,
  notificationSuppression,
  project,
  service,
  team,
  teammate,
  user,
} from '../../db/schema.ts'
import { type CatalogSqlRunner, syncNotificationCatalog } from './catalog-sync.ts'
import type { NotificationContext, NotificationSeverity } from './events.ts'
import type { PreferenceRow } from './resolve.ts'
import type {
  NotificationAudience,
  NotificationLevel,
  NotificationPreferenceKind,
  NotificationSuppressionReason,
  NotificationSuppressionSource,
} from './vocabulary.ts'

/** A `$1`-placeholder statement run through drizzle, so the catalog sync works on any runtime. */
export function drizzleCatalogRunner(db: Db): CatalogSqlRunner {
  return async (text, params) => {
    const parts = text.split(/\$(\d+)/)
    const chunks = parts.map((part, i) =>
      i % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1]}`
    )
    return await db.execute(sql.join(chunks, sql.raw('')))
  }
}

let catalogInStep = false

/**
 * Make sure `category` and `topic` hold this build's catalog, once per process.
 * Migrate already does it; this covers a database brought up any other way.
 * A module-level flag, not a cached client: the database is the caller's.
 */
export async function ensureNotificationCatalog(db: Db): Promise<void> {
  if (catalogInStep) return
  await syncNotificationCatalog(drizzleCatalogRunner(db))
  catalogInStep = true
}

/** Test seam: forget that the catalog was synced. */
export function resetNotificationCatalogFlag(): void {
  catalogInStep = false
}

function memberIdsQuery(db: Db, organizationId: string) {
  return db
    .selectDistinct({ userId: teammate.userId })
    .from(teammate)
    .innerJoin(team, eq(teammate.teamId, team.id))
    .where(eq(team.organizationId, organizationId))
}

/** Administrators who switched on hearing every organization. */
async function everyOrganizationAdminIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(
      and(inArray(user.role, ['admin', 'superadmin']), eq(user.isAllOrganizationsNotified, true))
    )
  return rows.map((r) => r.id)
}

/** Holders of own or manage on the organization, by any route; no administrator bypass. */
export async function organizationManagerHolderIds(
  db: Db,
  organizationId: string
): Promise<string[]> {
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
  for (const row of rows) {
    if (row.actorType === 'user') ids.add(row.actorId)
    else if (row.actorType === 'team') teamIds.push(row.actorId)
    else if (row.actorType === 'organization') {
      return (await memberIdsQuery(db, organizationId)).map((r) => r.userId)
    }
  }
  if (teamIds.length > 0) {
    const members = await db
      .selectDistinct({ userId: teammate.userId })
      .from(teammate)
      .where(inArray(teammate.teamId, teamIds))
    for (const m of members) ids.add(m.userId)
  }
  // A grant can outlive membership in a corner case; only members count.
  const members = new Set((await memberIdsQuery(db, organizationId)).map((r) => r.userId))
  return [...ids].filter((id) => members.has(id))
}

/** Everyone who may hear an event of this audience right now. */
export async function audienceRecipientIds(
  db: Db,
  audience: NotificationAudience,
  organizationId: string | null
): Promise<string[]> {
  if (audience === 'admins' || organizationId === null) {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(and(inArray(user.role, ['admin', 'superadmin']), eq(user.isDisabled, false)))
    return rows.map((r) => r.id)
  }
  const base =
    audience === 'managers'
      ? await organizationManagerHolderIds(db, organizationId)
      : (await memberIdsQuery(db, organizationId)).map((r) => r.userId)
  const ids = new Set(base)
  for (const id of await everyOrganizationAdminIds(db)) ids.add(id)
  if (ids.size === 0) return []
  const enabled = await db
    .select({ id: user.id })
    .from(user)
    .where(and(inArray(user.id, [...ids]), eq(user.isDisabled, false)))
  return enabled.map((r) => r.id)
}

function asPreference(row: typeof notificationPreference.$inferSelect): PreferenceRow {
  return {
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    serverId: row.serverId,
    destinationId: row.destinationId,
    channelId: row.channelId,
    categoryCode: row.categoryCode,
    topicCode: row.topicCode,
    kind: row.kind as NotificationPreferenceKind | null,
    level: row.level as NotificationLevel,
    endsAt: row.endsAt,
  }
}

/** Every preference row of these people that can apply in this organization (or install-wide). */
export async function preferenceRowsFor(
  db: Db,
  userIds: readonly string[],
  organizationId: string | null
): Promise<PreferenceRow[]> {
  if (userIds.length === 0) return []
  const rows = await db
    .select()
    .from(notificationPreference)
    .where(
      and(
        inArray(notificationPreference.userId, [...userIds]),
        organizationId
          ? or(
              isNull(notificationPreference.organizationId),
              eq(notificationPreference.organizationId, organizationId)
            )
          : isNull(notificationPreference.organizationId),
        or(isNull(notificationPreference.endsAt), sql`${notificationPreference.endsAt} > now()`)
      )
    )
  return rows.map(asPreference)
}

/** One person's rows, for the settings screens: every organization's or one's plus the global ones. */
export async function listPreferenceRows(
  db: Db,
  userId: string,
  organizationId?: string | null
): Promise<PreferenceRow[]> {
  const rows = await db
    .select()
    .from(notificationPreference)
    .where(
      and(
        eq(notificationPreference.userId, userId),
        organizationId === undefined
          ? undefined
          : organizationId === null
            ? isNull(notificationPreference.organizationId)
            : or(
                isNull(notificationPreference.organizationId),
                eq(notificationPreference.organizationId, organizationId)
              )
      )
    )
    .orderBy(notificationPreference.createdAt)
  return rows.map(asPreference)
}

/** The built-in account email channel for each person who has none yet; the address follows the account. */
export async function ensurePrimaryEmailChannels(
  db: Db,
  userIds: readonly string[]
): Promise<void> {
  if (userIds.length === 0) return
  await db.execute(sql`
    INSERT INTO ${notificationChannel} (scope, user_id, kind, label, address, verified_at, is_primary, created_by_user_id)
    SELECT 'user', u.id, 'email', 'Account email', u.email, now(), true, u.id
    FROM ${user} u
    WHERE u.id IN (${sql.join(
      userIds.map((id) => sql`${id}::uuid`),
      sql`, `
    )})
    ON CONFLICT (user_id, kind) WHERE is_primary DO NOTHING
  `)
}

/** The account emails of these people, lower-cased, with whether each is verified. */
export async function accountEmails(
  db: Db,
  userIds: readonly string[]
): Promise<Map<string, { email: string; verified: boolean }>> {
  if (userIds.length === 0) return new Map()
  const rows = await db
    .select({ id: user.id, email: user.email, verified: user.isEmailVerified })
    .from(user)
    .where(inArray(user.id, [...userIds]))
  return new Map(rows.map((r) => [r.id, { email: r.email, verified: r.verified }]))
}

/** The scope ids an event carries, with the parents filled in from the database. */
export type EventScopeIds = {
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  serverId: string | null
  destinationId: string | null
}

/**
 * Fill in the parents of the most specific id given, inside the organization:
 * a service names its environment and project, an environment its project.
 * An id that is not in the organization (or is already gone) is kept as given;
 * the parents stay null.
 */
export async function completeScope(
  db: Db,
  organizationId: string | null,
  given: Partial<EventScopeIds>
): Promise<EventScopeIds> {
  const out: EventScopeIds = {
    projectId: given.projectId ?? null,
    environmentId: given.environmentId ?? null,
    serviceId: given.serviceId ?? null,
    serverId: given.serverId ?? null,
    destinationId: given.destinationId ?? null,
  }
  if (!organizationId) return out
  if (out.serviceId && !out.environmentId) {
    const [row] = await db
      .select({ environmentId: service.environmentId })
      .from(service)
      .where(eq(service.id, out.serviceId))
      .limit(1)
    out.environmentId = row?.environmentId ?? null
  }
  if (out.environmentId && !out.projectId) {
    const [row] = await db
      .select({ projectId: environment.projectId })
      .from(environment)
      .innerJoin(project, eq(environment.projectId, project.id))
      .where(and(eq(environment.id, out.environmentId), eq(project.organizationId, organizationId)))
      .limit(1)
    out.projectId = row?.projectId ?? null
  }
  return out
}

export type EventInsert = {
  organizationId: string | null
  topicCode: string
  scope: EventScopeIds
  actorUserId: string | null
  severity: NotificationSeverity
  dedupe: string | null
  data: NotificationContext & Record<string, unknown>
}

/**
 * Write the event row. With a dedupe key and an open event under the same key,
 * the repeat is folded into it (`repeats` + 1) and null is returned: nothing
 * new to fan out. Topics ship with no cooldown, so today every occurrence is
 * its own event; the key is the seam for repeat limits.
 */
export async function insertEvent(db: Db, input: EventInsert): Promise<string | null> {
  if (input.dedupe) {
    const folded = await db.execute(sql`
      UPDATE ${notificationEvent} e
      SET repeats = e.repeats + 1, last_seen_at = now(), updated_at = now()
      FROM topic t
      WHERE e.dedupe = ${input.dedupe} AND e.status = 'open' AND t.code = e.topic_code
        AND e.last_seen_at > now() - t.cooldown
      RETURNING e.id
    `)
    if ((folded as unknown as unknown[]).length > 0) return null
    await db.execute(sql`
      UPDATE ${notificationEvent} SET status = 'closed', updated_at = now()
      WHERE dedupe = ${input.dedupe} AND status = 'open'
    `)
  }
  const [row] = await db
    .insert(notificationEvent)
    .values({
      organizationId: input.organizationId,
      topicCode: input.topicCode,
      ...input.scope,
      actorUserId: input.actorUserId,
      severity: input.severity,
      dedupe: input.dedupe,
      data: input.data,
    })
    .returning({ id: notificationEvent.id })
  return row?.id ?? null
}

export async function markEventFannedOut(db: Db, eventId: string): Promise<void> {
  await db
    .update(notificationEvent)
    .set({ fannedOutAt: sql`now()` })
    .where(eq(notificationEvent.id, eventId))
}

/** SHA-256 hex of the trimmed, lower-cased address — the only form `suppression` keeps. */
export async function addressHash(address: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(address.trim().toLowerCase())
  )
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Which of these addresses are suppressed now (by their lower-cased form). */
export async function suppressedAddresses(
  db: Db,
  addresses: readonly string[]
): Promise<Set<string>> {
  if (addresses.length === 0) return new Set()
  const byHash = new Map<string, string>()
  for (const address of addresses) {
    byHash.set(await addressHash(address), address.trim().toLowerCase())
  }
  const rows = await db
    .select({ hash: notificationSuppression.addressHash })
    .from(notificationSuppression)
    .where(
      and(
        inArray(notificationSuppression.addressHash, [...byHash.keys()]),
        isNull(notificationSuppression.clearedAt)
      )
    )
  return new Set(rows.flatMap((r) => (byHash.has(r.hash) ? [byHash.get(r.hash)!] : [])))
}

/** Stop sending to an address: a hard bounce or a refused recipient. Idempotent. */
export async function suppressAddress(
  db: Db,
  address: string,
  reason: NotificationSuppressionReason,
  source: NotificationSuppressionSource
): Promise<void> {
  await db
    .insert(notificationSuppression)
    .values({ addressHash: await addressHash(address), reason, source })
    .onConflictDoNothing()
}

/** A confirmed address is deliverable again. */
export async function clearSuppression(db: Db, address: string): Promise<void> {
  await db
    .update(notificationSuppression)
    .set({ clearedAt: sql`now()` })
    .where(
      and(
        eq(notificationSuppression.addressHash, await addressHash(address)),
        isNull(notificationSuppression.clearedAt)
      )
    )
}
