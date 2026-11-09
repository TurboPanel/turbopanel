/**
 * A person's notification preferences, and the one-click unsubscribe link.
 *
 *   GET    /notification-preferences            the person's rows (one organization's plus
 *                                               the global ones with `?organizationId=`),
 *                                               their personal channels, the catalog, and the
 *                                               effective level per channel kind at that scope
 *   GET    /notification-preferences/effective  effective level per kind at any scope, and the
 *                                               row it came from ("effective from")
 *   PUT    /notification-preferences            write one row (upsert by its scope tuple)
 *   DELETE /notification-preferences/:id        remove one of the person's rows
 *   POST   /notification-preferences/preset     quick presets for the bell and email at a scope
 *   PUT    /notification-settings               an administrator's "hear every organization"
 *   POST   /notification-unsubscribe/:token     RFC 8058 one-click: no session, never redirects
 *   GET    /notification-unsubscribe/:token     a person who opens the link: to the web page
 *
 * Nothing arrives until a person turns something on (owner decision
 * 2026-11-06), so the presets exist to make that one tap.
 */
import type { Context, Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { notificationChannel, notificationPreference, user } from '../../db/schema.ts'
import { canAccessOrganization } from '../org-context.ts'
import {
  accountEmails,
  ensureNotificationCatalog,
  ensurePrimaryEmailChannels,
  listPreferenceRows,
  resourceInOrganization,
  upsertPreference,
} from '../../features/notifications/fanout-records.ts'
import {
  type EventScope,
  type PreferenceRow,
  resolveLevel,
  scopeDepth,
} from '../../features/notifications/resolve.ts'
import {
  eventAudience,
  eventCategory,
  eventIsUrgent,
  eventLabel,
  eventScope,
  eventSeverity,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
} from '../../features/notifications/events.ts'
import {
  NOTIFICATION_LEVELS,
  type NotificationLevel,
  type NotificationPreferenceKind,
} from '../../features/notifications/vocabulary.ts'
import { applyUnsubscribe, openUnsubscribeToken } from '../../features/notifications/unsubscribe.ts'
import {
  describeChannelAddress,
  resolveChannelAddress,
} from '../../features/notifications/records.ts'
import { isUuid } from '../access/routes-helpers.ts'
import { isAdminRole } from '../authn/session-store.ts'

type Ctx = Context<AppEnv>

/** The kinds a person can set today; push waits for the phone apps. */
const SETTABLE_KINDS: readonly NotificationPreferenceKind[] = ['inbox', 'email', 'chat', 'webhook']

export const NOTIFICATION_PRESETS = {
  /** Everything in the bell and by email. */
  everything: { inbox: 'all', email: 'all' },
  /** Everything in the bell; warnings and critical by email. */
  recommended: { inbox: 'all', email: 'warning' },
  /** Critical only, in the bell and by email. */
  critical: { inbox: 'critical', email: 'critical' },
  /** Nothing in the bell or by email. */
  nothing: { inbox: 'none', email: 'none' },
} as const satisfies Record<string, Record<'inbox' | 'email', NotificationLevel>>
export type NotificationPreset = keyof typeof NOTIFICATION_PRESETS

export type PreferenceWrite = {
  organizationId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  serverId: string | null
  destinationId: string | null
  categoryCode: string | null
  topicCode: string | null
  kind: NotificationPreferenceKind | null
  channelId: string | null
  level: NotificationLevel
  endsAt: string | null
}

type Refusal = { ok: false; error: string }

function optionalUuid(body: Record<string, unknown>, key: string): string | null | Refusal {
  const value = body[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !isUuid(value))
    return { ok: false, error: `${key} must be an id` }
  return value
}

const ID_KEYS = [
  'organizationId',
  'projectId',
  'environmentId',
  'serviceId',
  'serverId',
  'destinationId',
  'channelId',
] as const
type IdKey = (typeof ID_KEYS)[number]
type Ids = Record<IdKey, string | null>

function parseIds(body: Record<string, unknown>): Ids | Refusal {
  const ids = {} as Ids
  for (const key of ID_KEYS) {
    const parsed = optionalUuid(body, key)
    if (parsed !== null && typeof parsed === 'object') return parsed
    ids[key] = parsed
  }
  return ids
}

/** The value-set fields: level, kind, category, topic. */
function vocabularyRefusal(body: Record<string, unknown>): string | null {
  const level = body.level
  if (typeof level !== 'string' || !(NOTIFICATION_LEVELS as readonly string[]).includes(level)) {
    return `level must be one of ${NOTIFICATION_LEVELS.join(', ')}`
  }
  const kind = body.kind ?? null
  if (kind !== null && !(SETTABLE_KINDS as readonly unknown[]).includes(kind)) {
    return `kind must be one of ${SETTABLE_KINDS.join(', ')}`
  }
  const category = body.categoryCode ?? null
  if (category !== null && !NOTIFICATION_CATEGORIES.some((c) => c.code === category)) {
    return 'unknown categoryCode'
  }
  const topic = body.topicCode ?? null
  if (topic !== null && !(NOTIFICATION_EVENTS as readonly unknown[]).includes(topic)) {
    return 'unknown topicCode'
  }
  return null
}

/** How the fields combine: the same rules as the table's CHECKs, said in words. */
function shapeRefusal(body: Record<string, unknown>, ids: Ids): string | null {
  if ((body.categoryCode ?? null) !== null && (body.topicCode ?? null) !== null) {
    return 'name a category or a topic, not both'
  }
  if (ids.channelId !== null && (body.kind ?? null) !== null) {
    return 'name a channel or a kind, not both'
  }
  if (ids.projectId !== null && ids.organizationId === null) {
    return 'a project needs its organizationId'
  }
  if (ids.environmentId !== null && ids.projectId === null) {
    return 'an environment needs its projectId'
  }
  const resources = [ids.serviceId, ids.serverId, ids.destinationId].filter((v) => v !== null)
  if (resources.length > 1) return 'name one resource at most'
  if (resources.length === 1 && ids.organizationId === null) {
    return 'a resource needs its organizationId'
  }
  const endsAt = body.endsAt ?? null
  if (endsAt !== null && (typeof endsAt !== 'string' || Number.isNaN(Date.parse(endsAt)))) {
    return 'endsAt must be an ISO time'
  }
  return null
}

/** Parse and shape-check one preference write; ownership is checked by the route. Pure. */
export function parsePreferenceWrite(raw: unknown): { ok: true; value: PreferenceWrite } | Refusal {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'body must be an object' }
  const body = raw as Record<string, unknown>
  const ids = parseIds(body)
  if ('ok' in ids) return ids as Refusal
  const refusal = vocabularyRefusal(body) ?? shapeRefusal(body, ids)
  if (refusal) return { ok: false, error: refusal }
  const endsAt = (body.endsAt ?? null) as string | null
  return {
    ok: true,
    value: {
      ...ids,
      categoryCode: (body.categoryCode ?? null) as string | null,
      topicCode: (body.topicCode ?? null) as string | null,
      kind: (body.kind ?? null) as NotificationPreferenceKind | null,
      level: body.level as NotificationLevel,
      endsAt: endsAt === null ? null : new Date(endsAt).toISOString(),
    },
  }
}

/** Where a deciding row sits, in words a screen can show next to a level. */
export function sourceScope(row: PreferenceRow | null): string {
  if (row === null) return 'default'
  switch (scopeDepth(row)) {
    case 5:
      if (row.serviceId) return 'service'
      return row.serverId ? 'server' : 'destination'
    case 4:
      return 'environment'
    case 3:
      return 'project'
    case 2:
      return 'organization'
    default:
      return 'global'
  }
}

/** Effective level per settable kind at one scope, with the deciding row. Pure. */
export function effectiveLevels(
  rows: readonly PreferenceRow[],
  scope: Omit<EventScope, 'topicCode' | 'categoryCode'> & {
    topicCode?: string
    categoryCode?: string
  },
  nowMs: number
): Record<string, { level: NotificationLevel; sourceId: string | null; source: string }> {
  // A row that names one topic or category is an override below the scope's
  // own level; the scope level itself is what a row naming neither decides.
  const subjectRows = rows.filter(
    (r) =>
      (r.topicCode === null || r.topicCode === scope.topicCode) &&
      (r.categoryCode === null || r.categoryCode === scope.categoryCode)
  )
  const full: EventScope = {
    ...scope,
    topicCode: scope.topicCode ?? '',
    categoryCode: scope.categoryCode ?? '',
  }
  const out: Record<string, { level: NotificationLevel; sourceId: string | null; source: string }> =
    {}
  for (const kind of SETTABLE_KINDS) {
    const r = resolveLevel(subjectRows, full, { kind, channelId: null }, nowMs)
    out[kind] = { level: r.level, sourceId: r.source?.id ?? null, source: sourceScope(r.source) }
  }
  return out
}

function presentRow(row: PreferenceRow) {
  return { ...row, scope: sourceScope(row) }
}

function catalog() {
  return {
    categories: NOTIFICATION_CATEGORIES.map((c) => ({ code: c.code, name: c.name })),
    topics: NOTIFICATION_EVENTS.map((event) => ({
      code: event,
      name: eventLabel(event),
      categoryCode: eventCategory(event),
      severity: eventSeverity(event),
      audience: eventAudience(event),
      scope: eventScope(event),
      urgent: eventIsUrgent(event),
    })),
  }
}

async function personalChannelSummaries(c: Ctx, db: Db, userId: string) {
  const rows = await db
    .select()
    .from(notificationChannel)
    .where(eq(notificationChannel.userId, userId))
    .orderBy(notificationChannel.createdAt)
  const secrets = c.get('dataEncryptionSecrets')
  // The account email channel sends to the account's address as it is now,
  // so that is the address (and the verified state) shown for it.
  const account = (await accountEmails(db, [userId])).get(userId)
  return await Promise.all(
    rows.map(async (row) => {
      const live = row.isPrimary && row.kind === 'email' ? account : undefined
      return {
        id: row.id,
        kind: row.kind,
        label: row.label,
        isPrimary: row.isPrimary,
        verified: live ? live.verified : row.verifiedAt !== null,
        disabled: row.disabledAt !== null,
        address:
          live?.email ??
          describeChannelAddress(
            row.kind as 'email',
            await resolveChannelAddress(secrets, {
              kind: row.kind as 'email',
              address: row.address,
            })
          ),
      }
    })
  )
}

/** The organization a request names, if the person may see it; a Response otherwise. */
async function organizationParam(
  c: Ctx,
  db: Db,
  userId: string,
  raw: string | undefined | null
): Promise<string | null | Response> {
  if (raw === undefined || raw === null || raw === '') return null
  if (!isUuid(raw)) return c.json({ error: 'Not found' }, 404)
  if (!(await canAccessOrganization(db, userId, raw))) return c.json({ error: 'Not found' }, 404)
  return raw
}

function scopeFromQuery(c: Ctx, organizationId: string | null) {
  const id = (key: string) => {
    const v = c.req.query(key)
    return v && isUuid(v) ? v : null
  }
  return {
    organizationId,
    projectId: organizationId ? id('projectId') : null,
    environmentId: organizationId ? id('environmentId') : null,
    serviceId: organizationId ? id('serviceId') : null,
    serverId: organizationId ? id('serverId') : null,
    destinationId: organizationId ? id('destinationId') : null,
  }
}

async function isAdministrator(db: Db, userId: string): Promise<{ admin: boolean; all: boolean }> {
  const [row] = await db
    .select({ role: user.role, all: user.isAllOrganizationsNotified })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  const admin = isAdminRole(row?.role)
  return { admin, all: admin && row?.all === true }
}

/** True when a Postgres error is a foreign key or CHECK refusal (a scope that is not where it says). */
function isRefusedReference(error: unknown): boolean {
  const code =
    (error as { code?: string; cause?: { code?: string } })?.code ??
    (error as { cause?: { code?: string } })?.cause?.code
  return code === '23503' || code === '23514'
}

async function getPreferences(c: Ctx): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const org = await organizationParam(c, db, sess.userId, c.req.query('organizationId'))
  if (org instanceof Response) return org
  await ensurePrimaryEmailChannels(db, [sess.userId])
  const rows = await listPreferenceRows(db, sess.userId, org)
  const admin = await isAdministrator(db, sess.userId)
  return c.json({
    rows: rows.map(presentRow),
    channels: await personalChannelSummaries(c, db, sess.userId),
    catalog: catalog(),
    presets: NOTIFICATION_PRESETS,
    effective: effectiveLevels(rows, scopeFromQuery(c, org), Date.now()),
    administrator: admin.admin,
    allOrganizations: admin.all,
  })
}

async function getEffective(c: Ctx): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const org = await organizationParam(c, db, sess.userId, c.req.query('organizationId'))
  if (org instanceof Response) return org
  const rows = await listPreferenceRows(db, sess.userId, org)
  const categoryCode = c.req.query('categoryCode') || undefined
  const topicCode = c.req.query('topicCode') || undefined
  return c.json({
    effective: effectiveLevels(
      rows,
      { ...scopeFromQuery(c, org), categoryCode, topicCode },
      Date.now()
    ),
  })
}

async function putPreference(c: Ctx): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const parsed = parsePreferenceWrite(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  const value = parsed.value
  const org = await organizationParam(c, db, sess.userId, value.organizationId)
  if (org instanceof Response) return org
  if (value.channelId) {
    const [own] = await db
      .select({ id: notificationChannel.id })
      .from(notificationChannel)
      .where(
        and(
          eq(notificationChannel.id, value.channelId),
          eq(notificationChannel.userId, sess.userId)
        )
      )
      .limit(1)
    if (!own) return c.json({ error: 'Not found' }, 404)
  }
  // A service, server or backup target of another organization answers
  // exactly like an id that does not exist, so the answer never says whether
  // a foreign id is real.
  if (org !== null && !(await resourceInOrganization(db, org, value))) {
    return c.json({ error: 'scope_not_in_organization' }, 422)
  }
  await ensureNotificationCatalog(db)
  try {
    const id = await upsertPreference(db, sess.userId, value)
    return c.json({ ok: true, id })
  } catch (error) {
    if (isRefusedReference(error)) {
      return c.json({ error: 'scope_not_in_organization' }, 422)
    }
    throw error
  }
}

async function deletePreference(c: Ctx): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const id = c.req.param('id') ?? ''
  if (!isUuid(id)) return c.json({ error: 'Not found' }, 404)
  const rows = await db
    .delete(notificationPreference)
    .where(and(eq(notificationPreference.id, id), eq(notificationPreference.userId, sess.userId)))
    .returning({ id: notificationPreference.id })
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
}

async function postPreset(c: Ctx): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const body = (await c.req.json().catch(() => null)) as {
    organizationId?: unknown
    preset?: unknown
  } | null
  const preset = body?.preset
  if (typeof preset !== 'string' || !Object.hasOwn(NOTIFICATION_PRESETS, preset)) {
    return c.json(
      { error: `preset must be one of ${Object.keys(NOTIFICATION_PRESETS).join(', ')}` },
      400
    )
  }
  const rawOrg = body?.organizationId
  const org = await organizationParam(
    c,
    db,
    sess.userId,
    typeof rawOrg === 'string' ? rawOrg : null
  )
  if (org instanceof Response) return org
  const levels = NOTIFICATION_PRESETS[preset as NotificationPreset]
  await Promise.all(
    (['inbox', 'email'] as const).map((kind) =>
      upsertPreference(db, sess.userId, {
        organizationId: org,
        projectId: null,
        environmentId: null,
        serviceId: null,
        serverId: null,
        destinationId: null,
        categoryCode: null,
        topicCode: null,
        kind,
        channelId: null,
        level: levels[kind],
        endsAt: null,
      })
    )
  )
  return c.json({ ok: true })
}

async function putSettings(c: Ctx): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const sess = c.get('session')
  if (!sess) return c.json({ error: 'Unauthorized' }, 401)
  const body = (await c.req.json().catch(() => null)) as { allOrganizations?: unknown } | null
  if (typeof body?.allOrganizations !== 'boolean') {
    return c.json({ error: 'allOrganizations must be true or false' }, 400)
  }
  const admin = await isAdministrator(db, sess.userId)
  if (!admin.admin) return c.json({ error: 'Forbidden' }, 403)
  await db
    .update(user)
    .set({ isAllOrganizationsNotified: body.allOrganizations })
    .where(eq(user.id, sess.userId))
  return c.json({ ok: true, allOrganizations: body.allOrganizations })
}

/**
 * RFC 8058: a cookie-less POST from the mail provider (or the web page). It
 * answers 200 with a small body and never redirects; an unknown or expired
 * token answers 400 so the page can say so.
 */
async function postUnsubscribe(c: Ctx): Promise<Response> {
  const db = getDb(c)
  if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
  const secrets = c.get('dataEncryptionSecrets')
  if (!secrets) return c.json({ ok: false, error: 'unavailable' }, 503)
  const claims = await openUnsubscribeToken(secrets, c.req.param('token') ?? '')
  if (!claims) return c.json({ ok: false, error: 'invalid_or_expired' }, 400)
  await ensureNotificationCatalog(db)
  const applied = await applyUnsubscribe(db, claims)
  return c.json({
    ok: applied,
    organizationId: claims.organizationId,
    categoryCode: claims.categoryCode,
  })
}

export function registerNotificationPreferenceRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for notification preference routes')
  }
  const session = createSessionMiddleware(opts.secrets)
  router.use('/notification-preferences', session)
  router.use('/notification-preferences/*', session)
  router.use('/notification-settings', session)

  router.get('/notification-preferences', (c) => getPreferences(c))
  router.get('/notification-preferences/effective', (c) => getEffective(c))
  router.put('/notification-preferences', (c) => putPreference(c))
  router.post('/notification-preferences/preset', (c) => postPreset(c))
  router.delete('/notification-preferences/:id', (c) => deletePreference(c))
  router.put('/notification-settings', (c) => putSettings(c))

  // No session on purpose: the mail provider posts here, and a person may
  // open the link signed out. The token is the authority.
  router.post('/notification-unsubscribe/:token', (c) => postUnsubscribe(c))
  router.get('/notification-unsubscribe/:token', (c) =>
    c.redirect(`/account/unsubscribe?token=${encodeURIComponent(c.req.param('token') ?? '')}`, 302)
  )
}
