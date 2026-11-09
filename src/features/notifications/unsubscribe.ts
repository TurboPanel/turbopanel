/**
 * One-click unsubscribe for notification email (RFC 8058).
 *
 * Every personal notification email carries `List-Unsubscribe` with one HTTPS
 * link and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The link holds
 * a token, not a stored row: the claims (the person, where the event happened,
 * its topic and category, and the personal channel when it is not the account
 * email) are sealed with the install's data-encryption key (AES-GCM, so the
 * token cannot be forged or altered) behind a fixed domain tag, with an expiry.
 * A POST to the link needs no session and never redirects.
 *
 * What it writes is decided when the link is used, with the same resolver the
 * fan-out uses (`planUnsubscribe`): the row that would send the next copy of
 * that mail is found, and a `none` row is written at that row's scope, at
 * least as specific in subject and target, so it replaces or outranks it. A
 * `none` row somewhere less specific would lose to the row that turned the
 * mail on. A single mail stops that category (or the topic, when a topic row
 * decided) where the deciding row sits, and the other categories still arrive;
 * a digest stops every row that sends email to that channel, in every
 * organization.
 *
 * Workers-bundle safe: Web Crypto only, nothing at module load.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { notificationChannel, teammate, team } from '../../db/schema.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  listPreferenceRows,
  type PreferenceScopeKey,
  preferenceRowsFor,
  upsertPreference,
} from './fanout-records.ts'
import { type CopyTarget, decidingRows, type EventScope, type PreferenceRow } from './resolve.ts'

/** The client API prefix; pinned to `CLIENT_API_PREFIX` in `app/surfaces.ts` by a test (features may not import surfaces). */
export const UNSUBSCRIBE_API_PREFIX = '/api/client/v1'

/** Domain tag sealed in front of the claims, so no other sealed value reads as a token. */
const TOKEN_TAG = 'notification-unsubscribe.v1:'

/** How long an unsubscribe link keeps working. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000

export type UnsubscribeClaims = {
  userId: string
  organizationId: string | null
  projectId: string | null
  environmentId: string | null
  serviceId: string | null
  serverId: string | null
  destinationId: string | null
  /** The event code of the mail; null on a digest and on a link from an older build. */
  topicCode: string | null
  categoryCode: string | null
  /** A personal email channel other than the account email; null means the account email. */
  channelId: string | null
  /** A digest: stop every row that sends email to this channel, in every organization. */
  everything: boolean
}

/** The claims of a link that names no event scope beyond these. */
export function unsubscribeClaims(
  claims: Pick<UnsubscribeClaims, 'userId'> & Partial<UnsubscribeClaims>
): UnsubscribeClaims {
  return {
    organizationId: null,
    projectId: null,
    environmentId: null,
    serviceId: null,
    serverId: null,
    destinationId: null,
    topicCode: null,
    categoryCode: null,
    channelId: null,
    everything: false,
    ...claims,
  }
}

/** Short keys, and absent when null, so the link stays well inside one header line. */
type SealedClaims = {
  u: string
  o?: string | null
  p?: string | null
  e?: string | null
  sv?: string | null
  sr?: string | null
  d?: string | null
  t?: string | null
  c?: string | null
  ch?: string | null
  a?: 1
  exp: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CATEGORY_RE = /^[a-z][a-z_]{1,39}$/
const TOPIC_RE = /^[a-z][a-z0-9_.]{1,79}$/

function optionalUuid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID_RE.test(value))
}

function optionalCode(value: unknown, pattern: RegExp): value is string | null {
  return value === null || (typeof value === 'string' && pattern.test(value))
}

export async function sealUnsubscribeToken(
  secrets: DerivedSecretsConfig,
  claims: UnsubscribeClaims,
  nowMs: number = Date.now()
): Promise<string> {
  const sealed: SealedClaims = { u: claims.userId, exp: nowMs + UNSUBSCRIBE_TOKEN_TTL_MS }
  if (claims.organizationId) sealed.o = claims.organizationId
  if (claims.projectId) sealed.p = claims.projectId
  if (claims.environmentId) sealed.e = claims.environmentId
  if (claims.serviceId) sealed.sv = claims.serviceId
  if (claims.serverId) sealed.sr = claims.serverId
  if (claims.destinationId) sealed.d = claims.destinationId
  if (claims.topicCode) sealed.t = claims.topicCode
  if (claims.categoryCode) sealed.c = claims.categoryCode
  if (claims.channelId) sealed.ch = claims.channelId
  if (claims.everything) sealed.a = 1
  return await encryptSecret(secrets, TOKEN_TAG + JSON.stringify(sealed))
}

function claimsFromSealed(c: Partial<SealedClaims>, nowMs: number): UnsubscribeClaims | null {
  if (typeof c.u !== 'string' || !UUID_RE.test(c.u)) return null
  const ids = [c.o, c.p, c.e, c.sv, c.sr, c.d, c.ch].map((v) => v ?? null)
  if (!ids.every(optionalUuid)) return null
  if (!optionalCode(c.c ?? null, CATEGORY_RE) || !optionalCode(c.t ?? null, TOPIC_RE)) return null
  if (typeof c.exp !== 'number' || c.exp <= nowMs) return null
  if (!c.o && ids.slice(1, 6).some((id) => id !== null)) return null
  const categoryCode = c.c ?? null
  const topicCode = c.t ?? null
  return {
    userId: c.u,
    organizationId: c.o ?? null,
    projectId: c.p ?? null,
    environmentId: c.e ?? null,
    serviceId: c.sv ?? null,
    serverId: c.sr ?? null,
    destinationId: c.d ?? null,
    topicCode,
    categoryCode,
    channelId: c.ch ?? null,
    // A link from an older build's digest named no organization and no subject.
    everything: c.a === 1 || (!c.o && categoryCode === null && topicCode === null),
  }
}

/** The claims of a genuine, unexpired token; null for anything else. Never throws. */
export async function openUnsubscribeToken(
  secrets: DerivedSecretsConfig,
  token: string,
  nowMs: number = Date.now()
): Promise<UnsubscribeClaims | null> {
  let plain: string
  try {
    plain = await decryptSecret(secrets, token)
  } catch {
    return null
  }
  if (!plain.startsWith(TOKEN_TAG)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(plain.slice(TOKEN_TAG.length))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  return claimsFromSealed(parsed as Partial<SealedClaims>, nowMs)
}

/** The one-click link: the API path, under the public base URL. */
export function unsubscribeUrl(base: string, token: string): string {
  const root = base.endsWith('/') ? base.slice(0, -1) : base
  return `${root}${UNSUBSCRIBE_API_PREFIX}/notification-unsubscribe/${encodeURIComponent(token)}`
}

/** The web interface page a person lands on from the footer link. */
export function unsubscribePageUrl(base: string, token: string): string {
  const root = base.endsWith('/') ? base.slice(0, -1) : base
  return `${root}/account/unsubscribe?token=${encodeURIComponent(token)}`
}

/** The email channel a link is about: its id, and whether it is the account email. */
export type UnsubscribeChannel = { id: string | null; isPrimary: boolean }

function scopeKeyOf(row: PreferenceScopeKey): string {
  return [
    row.organizationId,
    row.projectId,
    row.environmentId,
    row.serviceId,
    row.serverId,
    row.destinationId,
    row.categoryCode,
    row.topicCode,
    row.kind,
    row.channelId,
  ].join('|')
}

/** The channel a `none` row names: the deciding row's own, this channel, or every email for the account address. */
function capTarget(
  row: PreferenceRow | null,
  channel: UnsubscribeChannel
): Pick<PreferenceScopeKey, 'kind' | 'channelId'> {
  if (row?.channelId) return { kind: null, channelId: row.channelId }
  if (!channel.isPrimary && channel.id) return { kind: null, channelId: channel.id }
  return { kind: 'email', channelId: null }
}

/**
 * The `none` row that replaces or outranks `row`: same scope, a subject and a
 * target at least as specific. With a `categoryCode`, a row for every topic is
 * narrowed to that category so the other categories keep arriving.
 */
function capFor(
  row: PreferenceRow,
  channel: UnsubscribeChannel,
  categoryCode: string | null
): PreferenceScopeKey {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    serviceId: row.serviceId,
    serverId: row.serverId,
    destinationId: row.destinationId,
    topicCode: row.topicCode,
    categoryCode: row.topicCode ? null : (row.categoryCode ?? categoryCode),
    ...capTarget(row, channel),
  }
}

/** The rows as they read once `cap` is written: the same tuple becomes `none`, a new one is added. */
function withCap(rows: PreferenceRow[], userId: string, cap: PreferenceScopeKey): PreferenceRow[] {
  const key = scopeKeyOf(cap)
  const written: PreferenceRow = { id: `cap:${key}`, userId, ...cap, level: 'none', endsAt: null }
  const index = rows.findIndex((row) => scopeKeyOf(row) === key)
  if (index === -1) return [...rows, written]
  return rows.map((row, i) => (i === index ? { ...written, id: row.id } : row))
}

/** True when the row can send email to this channel at all. */
function reachesChannel(row: PreferenceRow, channel: UnsubscribeChannel): boolean {
  if (row.channelId) return row.channelId === channel.id
  return row.kind === null || row.kind === 'email'
}

/**
 * The `none` rows a link writes, given the person's rows. Pure, and tested
 * against `resolveLevel` (`unsubscribe.hostfree.test.ts`): after these rows
 * the next copy of the mail resolves to `none`.
 *
 * A row that mutes for a while (`none` with an end time) is left out of the
 * picture, so the mail stays off after that mute runs out. When nothing sends
 * the mail any more, one `none` row is still written where the event happened,
 * so the click is on record.
 */
export function planUnsubscribe(
  rows: readonly PreferenceRow[],
  claims: UnsubscribeClaims,
  channel: UnsubscribeChannel,
  nowMs: number
): PreferenceScopeKey[] {
  let live = rows.filter(
    (row) =>
      row.userId === claims.userId &&
      (row.endsAt === null || (row.level !== 'none' && Date.parse(row.endsAt) > nowMs))
  )
  const caps = new Map<string, PreferenceScopeKey>()
  const write = (cap: PreferenceScopeKey) => {
    caps.set(scopeKeyOf(cap), cap)
    live = withCap(live, claims.userId, cap)
  }
  if (claims.everything) {
    for (const row of live.filter((r) => r.level !== 'none' && reachesChannel(r, channel))) {
      write(capFor(row, channel, null))
    }
  } else {
    const scope: EventScope = {
      organizationId: claims.organizationId,
      projectId: claims.projectId,
      environmentId: claims.environmentId,
      serviceId: claims.serviceId,
      serverId: claims.serverId,
      destinationId: claims.destinationId,
      topicCode: claims.topicCode ?? '',
      categoryCode: claims.categoryCode ?? '',
    }
    const target: CopyTarget = { kind: 'email', channelId: channel.id }
    // Each pass turns off every row that decides now; a tie between two
    // resources of one event can leave another deciding row for the next pass.
    for (let pass = 0; pass <= rows.length; pass += 1) {
      const sending = decidingRows(live, scope, target, nowMs).filter((r) => r.level !== 'none')
      if (sending.length === 0) break
      for (const row of sending) write(capFor(row, channel, claims.categoryCode))
    }
  }
  if (caps.size === 0) {
    write({
      organizationId: claims.organizationId,
      projectId: claims.organizationId ? claims.projectId : null,
      environmentId: null,
      serviceId: null,
      serverId: null,
      destinationId: null,
      topicCode: null,
      categoryCode: claims.categoryCode,
      ...capTarget(null, channel),
    })
  }
  return [...caps.values()]
}

async function unsubscribeChannel(db: Db, claims: UnsubscribeClaims): Promise<UnsubscribeChannel> {
  if (claims.channelId) return { id: claims.channelId, isPrimary: false }
  const [primary] = await db
    .select({ id: notificationChannel.id })
    .from(notificationChannel)
    .where(
      and(
        eq(notificationChannel.userId, claims.userId),
        eq(notificationChannel.kind, 'email'),
        eq(notificationChannel.isPrimary, true)
      )
    )
    .limit(1)
  return { id: primary?.id ?? null, isPrimary: true }
}

/**
 * Write the `none` rows the link asks for (`planUnsubscribe`). The person must
 * still belong to the organization it names (a former member's link changes
 * nothing, and their rows there are gone already). Idempotent: a second click
 * writes the same rows. Returns false when nothing could be written.
 */
export async function applyUnsubscribe(
  db: Db,
  claims: UnsubscribeClaims,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (!claims.everything && claims.organizationId) {
    const [member] = await db
      .select({ id: teammate.id })
      .from(teammate)
      .innerJoin(team, eq(teammate.teamId, team.id))
      .where(
        and(eq(teammate.userId, claims.userId), eq(team.organizationId, claims.organizationId))
      )
      .limit(1)
    if (!member) return false
  }
  try {
    const channel = await unsubscribeChannel(db, claims)
    const rows = claims.everything
      ? await listPreferenceRows(db, claims.userId)
      : await preferenceRowsFor(db, [claims.userId], claims.organizationId)
    await Promise.all(
      planUnsubscribe(rows, claims, channel, nowMs).map((cap) =>
        upsertPreference(db, claims.userId, { ...cap, level: 'none', endsAt: null })
      )
    )
    return true
  } catch {
    // The project or channel is gone (foreign key): nothing left to stop.
    return false
  }
}
