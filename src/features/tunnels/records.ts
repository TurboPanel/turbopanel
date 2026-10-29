/**
 * Carriers (provider accounts) and badges (their API tokens) for an
 * organization. A token is sealed with `encryptSecret` into a `secret` row and
 * the badge only points at it; nothing here returns a token or the sealed
 * text. Removing a badge removes its secret row in the same transaction.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { badge, carrier, organization, secret, tunnel } from '../../db/schema.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CredentialReport } from './adapter.ts'
import { compareText } from './order.ts'
import {
  type BadgeCapabilities,
  BADGE_SECRET_PROVIDER,
  type DeclaredZone,
  RUN_SECRET_PROVIDER,
  TUNNEL_PROVIDERS,
  type TunnelProvider,
} from './vocabulary.ts'

export const MAX_CARRIERS_PER_ORG = 10
export const MAX_BADGES_PER_CARRIER = 50

/** A per-organization or per-carrier limit was reached; counted under a row lock so races cannot pass it. */
export class TunnelLimitError extends Error {
  readonly error: 'carrier_limit' | 'badge_limit'
  readonly limit: number
  constructor(error: 'carrier_limit' | 'badge_limit', limit: number) {
    super(error)
    this.name = 'TunnelLimitError'
    this.error = error
    this.limit = limit
  }
}

export type CarrierRow = typeof carrier.$inferSelect
export type BadgeRow = typeof badge.$inferSelect

export type ApiBadge = {
  id: string
  carrierId: string
  label: string
  lastFour: string
  capabilities: BadgeCapabilities
  /** Who owns the token at the provider, when known. */
  kind: string | null
  /** When the provider says the token stops working; null when it reports none. */
  expiresAt: string | null
  status: string
  lastCheckedAt: string | null
  createdAt: string
  /** Zones the person named for this token, so they can be shown and removed. */
  declaredZones: DeclaredZone[]
  /** Plain-words things to look at: a token about to expire, a right the provider refused. */
  warnings: string[]
}

export type ApiCarrier = {
  id: string
  provider: string
  name: string
  externalAccountId: string | null
  status: string
  createdAt: string
  badges: ApiBadge[]
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string; detail: string }

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/
const TOKEN_SHAPE = /^[\x21-\x7e]{8,512}$/

function textField(value: unknown, field: string, label: string, max: number): Parsed<string> {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    return { ok: false, field, detail: `${label} must be 1 to ${max} characters` }
  }
  return { ok: true, value: value.trim() }
}

export function parseCarrierBody(body: Record<string, unknown>): Parsed<{
  provider: TunnelProvider
  name: string
  externalAccountId: string | null
}> {
  const provider = TUNNEL_PROVIDERS.find((p) => p === body.provider)
  if (!provider) {
    return {
      ok: false,
      field: 'provider',
      detail: `The provider must be ${TUNNEL_PROVIDERS.join(', ')}`,
    }
  }
  const name = textField(body.name, 'name', 'The name', 64)
  if (!name.ok) return name
  const rawAccount = body.externalAccountId
  if (typeof rawAccount !== 'string' || !ACCOUNT_ID.test(rawAccount.trim())) {
    return {
      ok: false,
      field: 'externalAccountId',
      detail: 'The account id must be 1 to 64 letters, numbers, dashes or underscores',
    }
  }
  return { ok: true, value: { provider, name: name.value, externalAccountId: rawAccount.trim() } }
}

/** Zones one token may be told it covers. */
export const MAX_DECLARED_ZONES = 50
const ZONE_ID = /^[A-Za-z0-9_-]{1,64}$/
const ZONE_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** One zone the person names: its id, and its name when the provider may not tell us. */
export function parseDeclaredZone(value: unknown): Parsed<DeclaredZone> {
  const z = (value ?? {}) as Record<string, unknown>
  const id = typeof z.id === 'string' ? z.id.trim() : ''
  if (!ZONE_ID.test(id)) {
    return {
      ok: false,
      field: 'zones',
      detail: 'A zone id is 1 to 64 letters, numbers, dashes or underscores',
    }
  }
  const raw = typeof z.name === 'string' ? z.name.trim().toLowerCase() : ''
  if (raw && !ZONE_NAME.test(raw)) {
    return { ok: false, field: 'zones', detail: 'A zone name looks like example.com' }
  }
  return { ok: true, value: { id, name: raw } }
}

export function parseBadgeBody(
  body: Record<string, unknown>
): Parsed<{ label: string; token: string; zones: DeclaredZone[] }> {
  const label = textField(body.label, 'label', 'The label', 64)
  if (!label.ok) return label
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (!TOKEN_SHAPE.test(token)) {
    return {
      ok: false,
      field: 'token',
      detail: 'The token must be 8 to 512 visible characters, with no spaces',
    }
  }
  const zones: DeclaredZone[] = []
  if (body.zones !== undefined) {
    if (!Array.isArray(body.zones) || body.zones.length > MAX_DECLARED_ZONES) {
      return { ok: false, field: 'zones', detail: `Name up to ${MAX_DECLARED_ZONES} zones` }
    }
    for (const entry of body.zones) {
      const parsed = parseDeclaredZone(entry)
      if (!parsed.ok) return parsed
      if (!zones.some((z) => z.id === parsed.value.id)) zones.push(parsed.value)
    }
  }
  return { ok: true, value: { label: label.value, token, zones } }
}

function optionString(options: unknown, key: string): string | null {
  const value = (options as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : null
}

/** Keep only well-formed zone entries from stored data. */
function zoneList(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((z) =>
    z && typeof z.id === 'string' && typeof z.name === 'string' ? [{ id: z.id, name: z.name }] : []
  )
}

/** Days before a token's expiry from which it is flagged. */
export const BADGE_EXPIRY_WARNING_DAYS = 14

/** The zones the person named for a token; checks keep probing them. */
export function declaredZonesOf(row: Pick<BadgeRow, 'options'>): DeclaredZone[] {
  const stored = (row.options as Record<string, unknown> | null)?.declaredZones
  if (!Array.isArray(stored)) return []
  return stored.flatMap((z) =>
    z && typeof z.id === 'string'
      ? [{ id: z.id, name: typeof z.name === 'string' ? z.name : '' }]
      : []
  )
}

/** The last permission the provider refused for this token, kept so the screen can say so. */
export type BadgeFailure = {
  capability: 'tunnels' | 'dns' | 'certificates'
  zone: string | null
  at: string
}

function lastFailureOf(row: Pick<BadgeRow, 'options'>): BadgeFailure | null {
  const f = (row.options as Record<string, unknown> | null)?.lastFailure as
    Record<string, unknown> | undefined
  if (!f || typeof f.capability !== 'string' || typeof f.at !== 'string') return null
  const capability = f.capability
  if (capability !== 'tunnels' && capability !== 'dns' && capability !== 'certificates') return null
  return { capability, zone: typeof f.zone === 'string' ? f.zone : null, at: f.at }
}

/** What the provider refused, as the end of "when it tried to ...". */
function refusedAction(failure: BadgeFailure): string {
  const zone = failure.zone ? ` for ${failure.zone}` : ''
  if (failure.capability === 'tunnels') return 'change Tunnels'
  if (failure.capability === 'dns') return `edit DNS${zone}`
  return `manage certificates${zone}`
}

/** Plain-words notes for a token: nearing expiry, or a right the provider refused. */
export function badgeWarnings(row: BadgeRow, now: Date = new Date()): string[] {
  const out: string[] = []
  if (row.expiresAt) {
    const days = Math.ceil((Date.parse(row.expiresAt) - now.getTime()) / 86_400_000)
    if (days <= 0) out.push('This API Token has expired.')
    else if (days <= BADGE_EXPIRY_WARNING_DAYS) {
      out.push(`This API Token expires in ${days} day${days === 1 ? '' : 's'}.`)
    }
  }
  const failure = lastFailureOf(row)
  if (failure) {
    out.push(
      `Cloudflare refused this API Token when it tried to ${refusedAction(failure)}. Check its permissions.`
    )
  }
  return out
}

/** A badge as the API shows it: the label and the last four characters, never the token. */
export function toApiBadge(row: BadgeRow): ApiBadge {
  const stored = (row.capabilities ?? {}) as Record<string, unknown>
  const capabilities: BadgeCapabilities = {
    tunnels: stored.tunnels === true,
    dns: zoneList(stored.dns),
    certificates: zoneList(stored.certificates),
  }
  return {
    id: row.id,
    carrierId: row.carrierId,
    label: row.label,
    lastFour: row.lastFour,
    capabilities,
    kind: optionString(row.options, 'kind'),
    expiresAt: row.expiresAt,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    declaredZones: declaredZonesOf(row),
    warnings: badgeWarnings(row),
  }
}

export function toApiCarrier(row: CarrierRow, badges: BadgeRow[]): ApiCarrier {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    externalAccountId: row.externalAccountId,
    status: row.status,
    createdAt: row.createdAt,
    badges: badges.map(toApiBadge),
  }
}

export async function listCarriers(
  db: Db,
  organizationId: string
): Promise<{ carrier: CarrierRow; badges: BadgeRow[] }[]> {
  const carriers = await db
    .select()
    .from(carrier)
    .where(eq(carrier.organizationId, organizationId))
    .orderBy(asc(carrier.createdAt), asc(carrier.id))
  if (carriers.length === 0) return []
  const badges = await db
    .select()
    .from(badge)
    .where(
      inArray(
        badge.carrierId,
        carriers.map((c) => c.id)
      )
    )
    .orderBy(asc(badge.createdAt), asc(badge.id))
  return carriers.map((c) => ({ carrier: c, badges: badges.filter((b) => b.carrierId === c.id) }))
}

export async function findCarrier(
  db: Db,
  organizationId: string,
  carrierId: string
): Promise<CarrierRow | null> {
  const [row] = await db
    .select()
    .from(carrier)
    .where(and(eq(carrier.id, carrierId), eq(carrier.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

export async function listBadges(db: Db, carrierId: string): Promise<BadgeRow[]> {
  return await db
    .select()
    .from(badge)
    .where(eq(badge.carrierId, carrierId))
    .orderBy(asc(badge.createdAt), asc(badge.id))
}

export async function findBadge(
  db: Db,
  carrierId: string,
  badgeId: string
): Promise<BadgeRow | null> {
  const [row] = await db
    .select()
    .from(badge)
    .where(and(eq(badge.id, badgeId), eq(badge.carrierId, carrierId)))
    .limit(1)
  return row ?? null
}

export async function insertCarrier(
  db: Db,
  params: {
    organizationId: string
    provider: TunnelProvider
    name: string
    externalAccountId: string | null
  }
): Promise<CarrierRow> {
  // The organization row is locked while the count and the insert happen, so two
  // concurrent adds cannot both pass the limit.
  return await db.transaction(async (tx) => {
    await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, params.organizationId))
      .for('update')
    const existing = await tx
      .select({ id: carrier.id })
      .from(carrier)
      .where(eq(carrier.organizationId, params.organizationId))
    if (existing.length >= MAX_CARRIERS_PER_ORG) {
      throw new TunnelLimitError('carrier_limit', MAX_CARRIERS_PER_ORG)
    }
    // A carrier with no working token yet needs attention until a badge is added.
    const [row] = await tx
      .insert(carrier)
      .values({ ...params, status: 'attention' })
      .returning()
    return row!
  })
}

/** Seal a token for storage. */
export async function sealToken(secrets: DerivedSecretsConfig, token: string): Promise<string> {
  return await encryptSecret(secrets, token)
}

/** Open a stored token; used only to talk to the provider. */
export async function openBadgeToken(
  db: Db,
  secrets: DerivedSecretsConfig,
  row: BadgeRow
): Promise<string | null> {
  const [stored] = await db
    .select({ secretEnvelope: secret.secretEnvelope })
    .from(secret)
    .where(eq(secret.id, row.secretId))
    .limit(1)
  return stored ? await decryptSecret(secrets, stored.secretEnvelope) : null
}

export type CheckOutcome = { capabilities: CredentialReport['capabilities']; status: string }

/** The non-secret facts a check learned about the token itself. */
function tokenOptions(report: Pick<CredentialReport, 'token'>): Record<string, unknown> {
  return { kind: report.token.kind, tokenId: report.token.id }
}

/** The badge on this carrier that holds the provider token with this id, if any. */
export async function findBadgeByTokenId(
  db: Db,
  carrierId: string,
  tokenId: string
): Promise<BadgeRow | null> {
  const badges = await listBadges(db, carrierId)
  return badges.find((b) => optionString(b.options, 'tokenId') === tokenId) ?? null
}

export async function findCarrierByAccount(
  db: Db,
  organizationId: string,
  provider: string,
  externalAccountId: string
): Promise<CarrierRow | null> {
  const [row] = await db
    .select()
    .from(carrier)
    .where(
      and(
        eq(carrier.organizationId, organizationId),
        eq(carrier.provider, provider),
        eq(carrier.externalAccountId, externalAccountId)
      )
    )
    .limit(1)
  return row ?? null
}

/** A token is useful when it reaches tunnels or DNS. */
export function isUsefulReport(report: CredentialReport): boolean {
  // A token the provider calls disabled or expired is no use, whatever it once reached.
  const status = report.token.status
  if (status !== null && status !== 'active') return false
  return report.capabilities.tunnels || report.capabilities.dns.length > 0
}

/** Keep the carrier's status in step with its badges: active while any badge works. */
export async function refreshCarrierStatus(db: Db, carrierId: string): Promise<string> {
  const badges = await listBadges(db, carrierId)
  const status = badges.some((b) => b.status === 'active') ? 'active' : 'attention'
  await db.update(carrier).set({ status }).where(eq(carrier.id, carrierId))
  return status
}

/** Store a checked token: the sealed secret row and the badge, in one transaction. */
export async function insertBadge(
  db: Db,
  params: {
    organizationId: string
    carrier: CarrierRow
    label: string
    sealed: string
    lastFour: string
    report: CredentialReport
    declaredZones?: readonly DeclaredZone[]
  }
): Promise<BadgeRow> {
  const row = await db.transaction(async (tx) => {
    // The carrier row is locked while the count and the insert happen.
    await tx
      .select({ id: carrier.id })
      .from(carrier)
      .where(eq(carrier.id, params.carrier.id))
      .for('update')
    const held = await tx
      .select({ id: badge.id })
      .from(badge)
      .where(eq(badge.carrierId, params.carrier.id))
    if (held.length >= MAX_BADGES_PER_CARRIER) {
      throw new TunnelLimitError('badge_limit', MAX_BADGES_PER_CARRIER)
    }
    const [stored] = await tx
      .insert(secret)
      .values({
        organizationId: params.organizationId,
        provider: BADGE_SECRET_PROVIDER,
        name: `${params.carrier.name} ${params.label}`.slice(0, 120),
        secretEnvelope: params.sealed,
      })
      .returning({ id: secret.id })
    const [created] = await tx
      .insert(badge)
      .values({
        carrierId: params.carrier.id,
        secretId: stored!.id,
        label: params.label,
        lastFour: params.lastFour,
        capabilities: params.report.capabilities,
        options: {
          ...tokenOptions(params.report),
          ...(params.declaredZones?.length ? { declaredZones: namedZones(params) } : {}),
        },
        expiresAt: params.report.token.expiresAt,
        lastCheckedAt: new Date().toISOString(),
        status: 'active',
      })
      .returning()
    return created!
  })
  await refreshCarrierStatus(db, params.carrier.id)
  return row
}

/** The declared zones with the names the check found for them. */
function namedZones(params: {
  report: CredentialReport
  declaredZones?: readonly DeclaredZone[]
}): DeclaredZone[] {
  return (params.declaredZones ?? []).map((z) => ({
    id: z.id,
    name: params.report.declared?.find((d) => d.id === z.id)?.name ?? z.name,
  }))
}

export async function recordBadgeCheck(
  db: Db,
  row: BadgeRow,
  result: {
    capabilities: CredentialReport['capabilities']
    status: 'active' | 'attention'
    token?: CredentialReport['token']
  }
): Promise<BadgeRow> {
  const [updated] = await db
    .update(badge)
    .set({
      capabilities: result.capabilities,
      // A check that could not reach the provider keeps what was known before.
      ...(result.token
        ? {
            options: {
              ...clearFailure(row.options),
              ...tokenOptions({ token: result.token }),
            },
            expiresAt: result.token.expiresAt,
          }
        : {}),
      status: result.status,
      lastCheckedAt: new Date().toISOString(),
    })
    .where(eq(badge.id, row.id))
    .returning()
  await refreshCarrierStatus(db, row.carrierId)
  return updated!
}

/** The stored options without the last refused right; a fresh check replaces it. */
function clearFailure(options: unknown): Record<string, unknown> {
  const { lastFailure: _dropped, ...rest } = (options ?? {}) as Record<string, unknown>
  return rest
}

/** Remove a badge and its sealed token together. */
export async function deleteBadge(db: Db, row: BadgeRow): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(badge).where(eq(badge.id, row.id))
    await tx.delete(secret).where(eq(secret.id, row.secretId))
  })
  await refreshCarrierStatus(db, row.carrierId)
}

/** Remove a carrier with its badges and their sealed tokens. */
export async function deleteCarrier(db: Db, row: CarrierRow): Promise<void> {
  await db.transaction(async (tx) => {
    const badges = await tx
      .select({ secretId: badge.secretId })
      .from(badge)
      .where(eq(badge.carrierId, row.id))
    await tx.delete(carrier).where(eq(carrier.id, row.id))
    if (badges.length > 0) {
      await tx.delete(secret).where(
        inArray(
          secret.id,
          badges.map((b) => b.secretId)
        )
      )
    }
  })
}

/** Remove a tunnel and its sealed run token together (portals and doorways cascade). */
export async function deleteTunnelRecord(
  db: Db,
  row: Pick<typeof tunnel.$inferSelect, 'id' | 'secretId'>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(tunnel).where(eq(tunnel.id, row.id))
    if (row.secretId) await tx.delete(secret).where(eq(secret.id, row.secretId))
  })
}

/**
 * Seal a new run token for a tunnel and delete the old one, in one
 * transaction, so a rotated token never leaves its predecessor behind.
 */
export async function replaceTunnelRunSecret(
  db: Db,
  params: { tunnelId: string; organizationId: string; name: string; sealed: string }
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ secretId: tunnel.secretId })
      .from(tunnel)
      .where(eq(tunnel.id, params.tunnelId))
      .limit(1)
    const [created] = await tx
      .insert(secret)
      .values({
        organizationId: params.organizationId,
        provider: RUN_SECRET_PROVIDER,
        name: `${params.name} run token`.slice(0, 120),
        secretEnvelope: params.sealed,
      })
      .returning({ id: secret.id })
    await tx.update(tunnel).set({ secretId: created!.id }).where(eq(tunnel.id, params.tunnelId))
    if (current?.secretId) await tx.delete(secret).where(eq(secret.id, current.secretId))
  })
}

/** Does any tunnel still use this carrier? Used to answer 409 before a delete. */
export async function carrierHasTunnels(db: Db, carrierId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tunnel.id })
    .from(tunnel)
    .where(eq(tunnel.carrierId, carrierId))
    .limit(1)
  return row !== undefined
}

/** Does an `all` tunnel still cover this datacenter? Used to answer 409 before a delete. */
export async function datacenterHasAllTunnel(db: Db, datacenterId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tunnel.id })
    .from(tunnel)
    .where(and(eq(tunnel.datacenterId, datacenterId), eq(tunnel.placement, 'all')))
    .limit(1)
  return row !== undefined
}

// ---------------------------------------------------------------------------
// Choosing a token

/** What a call needs: account-wide tunnel rights, or DNS / certificate rights for one zone. */
export type BadgeNeed =
  | { capability: 'tunnels' }
  | { capability: 'dns' | 'certificates'; zone: { id: string; name?: string } }

/**
 * Why no token qualified: `capability` means no active token has that right at
 * all, `zone` means some do but none for this zone. Null when one qualifies.
 */
export type BadgeMissing = 'capability' | 'zone' | null

export type BadgePick = { badges: BadgeRow[]; missing: BadgeMissing }

function capabilitiesOfRow(row: Pick<BadgeRow, 'capabilities'>): BadgeCapabilities {
  const stored = (row.capabilities ?? {}) as Record<string, unknown>
  return {
    tunnels: stored.tunnels === true,
    dns: zoneList(stored.dns),
    certificates: zoneList(stored.certificates),
  }
}

/** The number of zones a token is limited to for one right (smaller is narrower). */
function scopeSize(row: BadgeRow, capability: 'dns' | 'certificates'): number {
  return capabilitiesOfRow(row)[capability].length
}

/** Most recently checked first; a never-checked token sorts last. */
function checkedAt(row: BadgeRow): number {
  return row.lastCheckedAt ? Date.parse(row.lastCheckedAt) || 0 : 0
}

/**
 * The tokens of one account that can do what is needed, best first. Only
 * active tokens qualify. For DNS and certificates the zone is matched by its
 * id (a zone deleted and added again has a new id), and a token limited to
 * fewer zones comes before one that reaches many; then the most recently
 * checked; then the oldest. The rows are returned so a caller can try the next
 * one when the provider refuses a write, and can record which token was used.
 */
export function pickBadges(badges: readonly BadgeRow[], need: BadgeNeed): BadgePick {
  const active = badges.filter((b) => b.status === 'active')
  const withRight = active.filter((b) => {
    const caps = capabilitiesOfRow(b)
    return need.capability === 'tunnels' ? caps.tunnels : caps[need.capability].length > 0
  })
  if (need.capability === 'tunnels') {
    return { badges: withRight.sort(byRecency), missing: withRight.length ? null : 'capability' }
  }
  const { capability, zone } = need
  const covering = withRight.filter((b) =>
    capabilitiesOfRow(b)[capability].some((z) => z.id === zone.id)
  )
  if (covering.length > 0) {
    covering.sort((a, b) => scopeSize(a, capability) - scopeSize(b, capability) || byRecency(a, b))
    return { badges: covering, missing: null }
  }
  return { badges: [], missing: withRight.length ? 'zone' : 'capability' }
}

function byRecency(a: BadgeRow, b: BadgeRow): number {
  return (
    checkedAt(b) - checkedAt(a) || compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id)
  )
}

/**
 * The zone a hostname belongs to, among the zones the account's active tokens
 * were found (or told) to reach for DNS. The longest matching zone name wins.
 */
export function findStoredZone(
  badges: readonly BadgeRow[],
  hostname: string
): { id: string; name: string } | null {
  const name = hostname.trim().toLowerCase()
  const zones = new Map<string, { id: string; name: string }>()
  for (const b of badges) {
    if (b.status !== 'active') continue
    for (const z of capabilitiesOfRow(b).dns) {
      const zoneName = z.name.toLowerCase()
      if (name === zoneName || name.endsWith(`.${zoneName}`)) zones.set(z.id, z)
    }
  }
  const best = [...zones.values()].sort(
    (a, b) => b.name.length - a.name.length || compareText(a.id, b.id)
  )
  return best[0] ?? null
}

/**
 * The provider refused a write this token needed: take that right (or that
 * zone) away from the stored scope, so no other call picks it again, and keep
 * what was refused so the screen can say so. A check restores it if it works.
 */
export async function recordBadgeFailure(
  db: Db,
  row: BadgeRow,
  failure: {
    capability: 'tunnels' | 'dns' | 'certificates'
    zone: { id: string; name: string } | null
    /** The provider no longer accepts the token at all (rolled or removed). */
    whole?: boolean
  }
): Promise<void> {
  const caps = capabilitiesOfRow(row)
  const next: BadgeCapabilities = failure.whole
    ? { tunnels: false, dns: [], certificates: [] }
    : failure.capability === 'tunnels'
      ? { ...caps, tunnels: false }
      : {
          ...caps,
          [failure.capability]: failure.zone
            ? caps[failure.capability].filter((z) => z.id !== failure.zone!.id)
            : [],
        }
  const usable = next.tunnels || next.dns.length > 0
  await db
    .update(badge)
    .set({
      capabilities: next,
      status: usable ? row.status : 'attention',
      options: {
        ...(row.options as object | null),
        lastFailure: {
          capability: failure.capability,
          zone: failure.zone?.name ?? null,
          at: new Date().toISOString(),
        },
      },
    })
    .where(eq(badge.id, row.id))
  await refreshCarrierStatus(db, row.carrierId)
}

/** Keep the zones the person named with the token, so every later check probes them again. */
export async function setDeclaredZones(
  db: Db,
  row: BadgeRow,
  zones: readonly DeclaredZone[]
): Promise<BadgeRow> {
  const [updated] = await db
    .update(badge)
    .set({ options: { ...(row.options as object | null), declaredZones: zones } })
    .where(eq(badge.id, row.id))
    .returning()
  return updated!
}
