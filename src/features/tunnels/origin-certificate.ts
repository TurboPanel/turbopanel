/**
 * Origin certificates: the optional certificate for the short hop between a
 * tunnel provider and the web server (Caddy) on the same machine. With it the
 * connector can verify that hop instead of skipping verification.
 *
 * TurboPanel makes the key and the request, sends only the request to the
 * provider and keeps the issued pair in the organization certificate library
 * (`tls`, source `provider_origin`) with the key sealed like every other
 * certificate key. A row covers one zone (the zone name and `*.` the zone
 * name), so one certificate serves every site in the zone on every server.
 *
 * The provider side of a row lives in `tls.metadata.providerOrigin`: the
 * carrier, the badge whose token can revoke it, the zone and the provider's
 * certificate id. None of it is returned by the TLS routes (the public row is
 * assembled from known fields only).
 *
 * Renewal issues a replacement and re-pins the sites that used the old row;
 * the old row is revoked later, once nothing pins it (a grace period keeps a
 * running site from losing its certificate before the next deploy). Tunnel
 * only names never get an automatic public certificate request: nothing here
 * touches the Let's Encrypt paths.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { badge, carrier, hosting, tls } from '../../db/schema.ts'
import { encryptSecret, isSealedEnvelope } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { mintCertificateRequest, parseCertificatePem } from '../../lib/tls/index.ts'
import { coversHostname, normalizeHostname } from '../../lib/tls/match.ts'
import { metadataFromParsed, splitTlsMetadata } from '../../lib/tls/metadata.ts'
import type { TunnelAdapter } from './adapter.ts'
import { TunnelProviderError } from './errors.ts'
import { type BadgeRow, type CarrierRow, openBadgeToken, toApiBadge } from './records.ts'

const MS_PER_DAY = 86_400_000

/** How long an issued certificate is valid. Renewal is automatic, so a year is plenty. */
export const ORIGIN_CERTIFICATE_VALID_DAYS = 365
/** A certificate with less than this left is replaced. */
export const ORIGIN_CERTIFICATE_RENEW_BEFORE_DAYS = 30
/** At most this many origin certificates per organization. */
export const MAX_ORIGIN_CERTIFICATES_PER_ORG = 50

export type OriginCertificateError =
  | 'unsupported_provider'
  | 'zone_not_covered'
  | 'secrets_unavailable'
  | 'badge_cannot_certify'
  | 'origin_certificate_limit'
  | 'tls_in_use'
  | 'badge_missing'
  | 'not_found'

/** A refusal with a stable code; the route turns it into a plain-words reply. */
export class OriginCertificateRefusal extends Error {
  readonly error: OriginCertificateError
  constructor(error: OriginCertificateError, message: string) {
    super(message)
    this.name = 'OriginCertificateRefusal'
    this.error = error
  }
}

/** The provider details kept with the library row. */
export type ProviderOriginLink = {
  provider: string
  carrierId: string
  badgeId: string
  zoneId: string
  zoneName: string
  externalId: string
}

export type TlsRow = typeof tls.$inferSelect

/** The names one certificate covers for a zone: the zone itself and everything one label below it. */
export function originCertificateNames(zoneName: string): string[] {
  const zone = zoneName.trim().toLowerCase()
  return [zone, `*.${zone}`]
}

export function originCertificateIsDue(notAfter: string | null, now: Date = new Date()): boolean {
  if (!notAfter) return true
  const left = Date.parse(notAfter) - now.getTime()
  return Number.isNaN(left) || left < ORIGIN_CERTIFICATE_RENEW_BEFORE_DAYS * MS_PER_DAY
}

/** Read the provider link back from a row's metadata; null when it is missing or malformed. */
export function readProviderOrigin(metadata: unknown): ProviderOriginLink | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const raw = (metadata as Record<string, unknown>).providerOrigin
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const keys = ['provider', 'carrierId', 'badgeId', 'zoneId', 'zoneName', 'externalId'] as const
  for (const key of keys) {
    if (typeof r[key] !== 'string' || (r[key] as string).length === 0) return null
  }
  return {
    provider: r.provider as string,
    carrierId: r.carrierId as string,
    badgeId: r.badgeId as string,
    zoneId: r.zoneId as string,
    zoneName: r.zoneName as string,
    externalId: r.externalId as string,
  }
}

/** The best ready origin certificate that covers a hostname, or null. */
export function pickOriginCertificate(rows: readonly TlsRow[], hostname: string): TlsRow | null {
  const name = normalizeHostname(hostname)
  const usable = rows.filter((row) => {
    if (row.source !== 'provider_origin' || row.status !== 'ready') return false
    const link = readProviderOrigin(row.metadata)
    if (!link) return false
    return coversHostname(originCertificateNames(link.zoneName), name)
  })
  usable.sort((a, b) => (b.notAfter ?? '').localeCompare(a.notAfter ?? ''))
  return usable[0] ?? null
}

export async function listOriginCertificates(
  db: Db,
  organizationId: string,
  carrierId?: string
): Promise<TlsRow[]> {
  const rows = await db
    .select()
    .from(tls)
    .where(and(eq(tls.organizationId, organizationId), eq(tls.source, 'provider_origin')))
    .orderBy(tls.createdAt)
  return carrierId
    ? rows.filter((row) => readProviderOrigin(row.metadata)?.carrierId === carrierId)
    : rows
}

/** How many origin certificates a badge or a carrier issued; removing either needs them gone first. */
export async function countOriginCertificatesFrom(
  db: Db,
  organizationId: string,
  from: { badgeId: string } | { carrierId: string }
): Promise<number> {
  const rows = await listOriginCertificates(db, organizationId)
  return rows.filter((row) => {
    const link = readProviderOrigin(row.metadata)
    if (!link) return false
    return 'badgeId' in from ? link.badgeId === from.badgeId : link.carrierId === from.carrierId
  }).length
}

/** Ids of hostings that pin a certificate. */
export async function hostingsPinning(db: Db, tlsId: string): Promise<string[]> {
  const rows = await db.select({ id: hosting.id }).from(hosting).where(eq(hosting.tlsId, tlsId))
  return rows.map((row) => row.id)
}

/** A badge that can issue for the zone: it must have been proved to read the zone's certificates. */
export function badgeCoversZone(row: BadgeRow, zoneName: string): { id: string; name: string } | null {
  const zones = toApiBadge(row).capabilities.certificates
  const wanted = zoneName.trim().toLowerCase()
  return zones.find((z) => z.name.toLowerCase() === wanted) ?? null
}

type IssueParams = {
  db: Db
  secrets: DerivedSecretsConfig
  adapter: TunnelAdapter
  organizationId: string
  carrier: CarrierRow
  badge: BadgeRow
  zoneName: string
}

async function countOriginCertificates(db: Db, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tls)
    .where(and(eq(tls.organizationId, organizationId), eq(tls.source, 'provider_origin')))
  return row?.n ?? 0
}

async function revokeAtProvider(
  adapter: TunnelAdapter,
  token: string,
  externalId: string
): Promise<void> {
  try {
    await adapter.revokeOriginCertificate?.(token, { externalId })
  } catch (err) {
    // A certificate the provider no longer knows is as good as revoked.
    if (err instanceof TunnelProviderError && err.code === 'not_found') return
    throw err
  }
}

/**
 * Ask the provider for a certificate for one zone and store it. The private
 * key is made here and never leaves this function except sealed into the row.
 * If storing fails after the provider issued the certificate, it is revoked
 * again so nothing is left behind.
 */
export async function issueOriginCertificate(params: IssueParams): Promise<TlsRow> {
  const { db, secrets, adapter, organizationId } = params
  if (!adapter.issueOriginCertificate || !adapter.revokeOriginCertificate) {
    throw new OriginCertificateRefusal(
      'unsupported_provider',
      'This provider does not issue origin certificates'
    )
  }
  const zone = badgeCoversZone(params.badge, params.zoneName)
  if (!zone) {
    throw new OriginCertificateRefusal(
      'badge_cannot_certify',
      'This API token cannot manage certificates for that zone'
    )
  }
  if ((await countOriginCertificates(db, organizationId)) >= MAX_ORIGIN_CERTIFICATES_PER_ORG) {
    throw new OriginCertificateRefusal(
      'origin_certificate_limit',
      'This organization has reached its limit of origin certificates'
    )
  }
  const token = await openBadgeToken(db, secrets, params.badge)
  if (token === null) {
    throw new OriginCertificateRefusal('secrets_unavailable', 'The stored API token cannot be read')
  }
  const names = originCertificateNames(zone.name)
  const request = await mintCertificateRequest(names)
  const issued = await adapter.issueOriginCertificate(token, {
    hostnames: names,
    csrPem: request.csrPem,
    validityDays: ORIGIN_CERTIFICATE_VALID_DAYS,
  })
  try {
    const parsed = await parseCertificatePem(issued.certificatePem)
    const sealedKey = await encryptSecret(secrets, request.privateKeyPem)
    if (!isSealedEnvelope(sealedKey) || sealedKey.includes('BEGIN')) {
      throw new TypeError('the certificate key must be sealed before it is stored')
    }
    const { columns, residual } = splitTlsMetadata(metadataFromParsed(parsed, 'ready'))
    const link: ProviderOriginLink = {
      provider: params.carrier.provider,
      carrierId: params.carrier.id,
      badgeId: params.badge.id,
      zoneId: zone.id,
      zoneName: zone.name.toLowerCase(),
      externalId: issued.externalId,
    }
    const [row] = await db
      .insert(tls)
      .values({
        organizationId,
        name: `Origin ${zone.name.toLowerCase()}`.slice(0, 255),
        source: 'provider_origin',
        certificatePem: issued.certificatePem,
        privateKeyPem: sealedKey,
        status: columns.status,
        notAfter: columns.notAfter,
        fingerprintSha256: columns.fingerprintSha256,
        metadata: { ...residual, providerOrigin: link },
        options: null,
      })
      .returning()
    return row!
  } catch (err) {
    // Best effort: do not leave a certificate at the provider that nothing in the panel knows about.
    await revokeAtProvider(adapter, token, issued.externalId).catch(() => undefined)
    throw err
  }
}

type RevokeParams = {
  db: Db
  secrets: DerivedSecretsConfig
  adapter: TunnelAdapter
  row: TlsRow
  /** Remove the row even when the provider cannot be reached or its token is gone. */
  force?: boolean
}

/**
 * Revoke a certificate at the provider and remove the row. Refused while a
 * site pins it; the caller moves the site first.
 */
export async function revokeOriginCertificate(params: RevokeParams): Promise<void> {
  const { db, secrets, adapter, row } = params
  if ((await hostingsPinning(db, row.id)).length > 0) {
    throw new OriginCertificateRefusal('tls_in_use', 'A site still uses this certificate')
  }
  const link = readProviderOrigin(row.metadata)
  if (link && adapter.revokeOriginCertificate) {
    const [badgeRow] = await db
      .select()
      .from(badge)
      .where(and(eq(badge.id, link.badgeId), eq(badge.carrierId, link.carrierId)))
      .limit(1)
    const token = badgeRow ? await openBadgeToken(db, secrets, badgeRow) : null
    if (token === null) {
      if (!params.force) {
        throw new OriginCertificateRefusal(
          'badge_missing',
          'The API token that issued this certificate is gone, so it cannot be revoked'
        )
      }
    } else {
      await revokeAtProvider(adapter, token, link.externalId)
    }
  }
  await db.delete(tls).where(eq(tls.id, row.id))
}

export type RenewResult = {
  replacement: TlsRow
  /**
   * Sites now pinned to the replacement. Their web servers keep serving the
   * old certificate until the next deploy, so the caller (a surface that can
   * queue a hostings-only deploy) must push these; the old certificate stays
   * valid until its own expiry, which is why it is not revoked here.
   */
  repinnedHostingIds: string[]
}

/**
 * Replace a certificate that is close to expiry: issue a new one and re-point
 * the sites that pinned the old one. The old row stays until it expires.
 */
export async function renewOriginCertificate(
  params: Omit<IssueParams, 'zoneName' | 'carrier' | 'badge'> & { row: TlsRow }
): Promise<RenewResult | null> {
  const link = readProviderOrigin(params.row.metadata)
  if (!link) return null
  const [carrierRow] = await params.db
    .select()
    .from(carrier)
    .where(and(eq(carrier.id, link.carrierId), eq(carrier.organizationId, params.organizationId)))
    .limit(1)
  const [badgeRow] = await params.db
    .select()
    .from(badge)
    .where(and(eq(badge.id, link.badgeId), eq(badge.carrierId, link.carrierId)))
    .limit(1)
  if (!carrierRow || !badgeRow) return null
  const replacement = await issueOriginCertificate({
    ...params,
    carrier: carrierRow,
    badge: badgeRow,
    zoneName: link.zoneName,
  })
  const moved = await params.db
    .update(hosting)
    .set({ tlsId: replacement.id })
    .where(eq(hosting.tlsId, params.row.id))
    .returning({ id: hosting.id })
  return { replacement, repinnedHostingIds: moved.map((h) => h.id) }
}

/** A newer certificate for the same zone exists. */
export function isSuperseded(rows: readonly TlsRow[], row: TlsRow): boolean {
  const link = readProviderOrigin(row.metadata)
  if (!link) return false
  return rows.some((other) => {
    const otherLink = readProviderOrigin(other.metadata)
    return (
      other.id !== row.id &&
      otherLink?.carrierId === link.carrierId &&
      otherLink.zoneName === link.zoneName &&
      other.createdAt > row.createdAt
    )
  })
}

export type OriginSweepResult = {
  renewed: string[]
  /** Sites the caller still has to push the new certificate to. */
  repinnedHostingIds: string[]
  /** Replaced certificates removed after their own expiry. */
  removed: string[]
  failed: string[]
}

/**
 * One pass over an organization's origin certificates: renew those that are
 * pinned and close to expiry, and drop those that were replaced and have now
 * expired (an expired certificate needs no revoking). Nothing calls this yet:
 * the sweep is wired when a tunnel can ask for a certificate and the sites it
 * serves are pinned automatically. A failure on one row is recorded and does
 * not stop the others.
 */
export async function sweepOriginCertificates(params: {
  db: Db
  secrets: DerivedSecretsConfig
  registry: (provider: CarrierRow['provider']) => TunnelAdapter
  organizationId: string
  now?: Date
}): Promise<OriginSweepResult> {
  const now = params.now ?? new Date()
  const result: OriginSweepResult = { renewed: [], repinnedHostingIds: [], removed: [], failed: [] }
  const rows = await listOriginCertificates(params.db, params.organizationId)
  for (const row of rows) {
    const link = readProviderOrigin(row.metadata)
    if (!link) continue
    try {
      const pinned = (await hostingsPinning(params.db, row.id)).length > 0
      if (pinned && originCertificateIsDue(row.notAfter, now)) {
        const renewed = await renewOriginCertificate({
          db: params.db,
          secrets: params.secrets,
          adapter: params.registry(link.provider as CarrierRow['provider']),
          organizationId: params.organizationId,
          row,
        })
        if (renewed) {
          result.renewed.push(renewed.replacement.id)
          result.repinnedHostingIds.push(...renewed.repinnedHostingIds)
        }
      } else if (
        !pinned &&
        isSuperseded(rows, row) &&
        row.notAfter !== null &&
        Date.parse(row.notAfter) <= now.getTime()
      ) {
        await params.db.delete(tls).where(eq(tls.id, row.id))
        result.removed.push(row.id)
      }
    } catch {
      result.failed.push(row.id)
    }
  }
  return result
}
