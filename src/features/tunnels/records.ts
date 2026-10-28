/**
 * Carriers (provider accounts) and badges (their API tokens) for an
 * organization. A token is sealed with `encryptSecret` into a `secret` row and
 * the badge only points at it; nothing here returns a token or the sealed
 * text. Removing a badge removes its secret row in the same transaction.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { badge, carrier, secret, tunnel } from '../../db/schema.ts'
import { decryptSecret, encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CredentialReport } from './adapter.ts'
import {
  type BadgeCapabilities,
  BADGE_SECRET_PROVIDER,
  RUN_SECRET_PROVIDER,
  TUNNEL_PROVIDERS,
  type TunnelProvider,
} from './vocabulary.ts'

export const MAX_CARRIERS_PER_ORG = 10
export const MAX_BADGES_PER_CARRIER = 5

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

type Parsed<T> = { ok: true; value: T } | { ok: false; field: string; detail: string }

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

export function parseBadgeBody(
  body: Record<string, unknown>
): Parsed<{ label: string; token: string }> {
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
  return { ok: true, value: { label: label.value, token } }
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
  // A carrier with no working token yet needs attention until a badge is added.
  const [row] = await db
    .insert(carrier)
    .values({ ...params, status: 'attention' })
    .returning()
  return row!
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
  }
): Promise<BadgeRow> {
  const row = await db.transaction(async (tx) => {
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
        options: tokenOptions(params.report),
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
              ...((row.options as object | null) ?? {}),
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
