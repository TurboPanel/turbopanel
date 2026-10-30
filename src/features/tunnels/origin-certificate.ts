/**
 * Origin certificates: the optional certificate for the short hop between a
 * tunnel provider and the web server (Caddy) on the same machine. With it the
 * connector can verify that hop instead of skipping verification.
 *
 * TurboPanel makes the key and the request, sends only the request to the
 * provider and keeps the issued pair in the organization certificate library
 * (`tls`, source `provider_origin`) with the key sealed like every other
 * certificate key. The default is a certificate for EXACT hostnames: the names
 * one site serves, issued on demand. A wildcard (the zone and `*.` the zone) is
 * an explicit opt-in per zone: its key could impersonate any name under the
 * zone, a revocation takes every site with it, and it does not cover names two
 * labels down.
 *
 * The provider side of a row lives in `tls.metadata.providerOrigin`: the
 * carrier, the badge whose token can revoke it, the zone, the provider's
 * certificate id, the exact names, the scope and, once nothing needs it, the
 * time it was retired. None of it is returned by the TLS routes (the public row
 * is assembled from known fields only).
 *
 * A certificate is only ever replaced, never edited: when a site gains another
 * name a new certificate lists all of them, the old one is marked retired, and
 * it is revoked later, once no site pins it and a grace period has passed (so
 * a running site keeps a working certificate until its next deploy). A
 * certificate whose last name is gone is retired the same way. Only certificates
 * TurboPanel issued are ever revoked. Tunnel-only names never get an automatic
 * public certificate request: nothing here touches the Let's Encrypt paths.
 */
import { and, eq, sql } from 'drizzle-orm'
import { isValidHostname } from '../../contracts/commands/hostname.ts'
import type { Db } from '../../db/connection.ts'
import { carrier, hosting, tls } from '../../db/schema.ts'
import { encryptSecret, isSealedEnvelope } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { mintCertificateRequest, parseCertificatePem } from '../../lib/tls/index.ts'
import { coversHostname } from '../../lib/tls/match.ts'
import { metadataFromParsed, splitTlsMetadata } from '../../lib/tls/metadata.ts'
import type { ProviderOriginCertificate, TunnelAdapter } from './adapter.ts'
import type { TunnelProvider } from './vocabulary.ts'
import { TunnelProviderError } from './errors.ts'
import { compareText } from './order.ts'
import { logWarn } from '../../lib/logger.ts'
import { mapSequential } from '../../lib/sequential.ts'
import {
  countThrottle,
  emptyThrottleCounters,
  type ThrottleCounters,
} from '../../lib/throttle-counters.ts'
import { BadgeRefused, BadgeUnavailable, useBadges } from './badge-use.ts'
import {
  nextOriginRetry,
  originRetryWaiting,
  pauseOriginRow,
  readOriginRetry,
  saveOriginRetry,
  throttleWait,
} from './origin-certificate-retry.ts'
import {
  type BadgeRow,
  type CarrierRow,
  listBadges,
  openBadgeToken,
  pickBadges,
  toApiBadge,
} from './records.ts'

const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000

/** How long an issued certificate is valid. Renewal is automatic, so a year is plenty. */
export const ORIGIN_CERTIFICATE_VALID_DAYS = 365
/** A certificate with less than this left is replaced. */
export const ORIGIN_CERTIFICATE_RENEW_BEFORE_DAYS = 30
/** At most this many origin certificates per organization. */
export const MAX_ORIGIN_CERTIFICATES_PER_ORG = 50
/** The provider refuses a request for more than 100 names ("up to 100 per certificate"). */
export const MAX_ORIGIN_CERTIFICATE_NAMES = 100
/** A retired certificate is revoked only after nothing pins it and this long has passed. */
export const ORIGIN_CERTIFICATE_RETIRE_GRACE_HOURS = 24

export type OriginCertificateError =
  | 'unsupported_provider'
  | 'zone_not_covered'
  | 'secrets_unavailable'
  | 'badge_cannot_certify'
  | 'origin_certificate_limit'
  | 'origin_certificate_names'
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

/** `names` is a certificate for exact hostnames (the default); `wildcard` is the zone and `*.` the zone. */
export type OriginCertificateScope = 'names' | 'wildcard'

/** The provider details kept with the library row. */
export type ProviderOriginLink = {
  provider: string
  carrierId: string
  badgeId: string
  zoneId: string
  zoneName: string
  externalId: string
  /** The names on the certificate, lowercase, in code-point order. */
  hostnames: string[]
  scope: OriginCertificateScope
  /** ISO time it stopped being needed (replaced, or its last name was removed); null while in use. */
  retiredAt: string | null
}

export type TlsRow = typeof tls.$inferSelect

/** The names of a wildcard certificate for a zone: the zone itself and everything one label below it. */
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
  const hostnames = r.hostnames
  if (
    !Array.isArray(hostnames) ||
    hostnames.length === 0 ||
    !hostnames.every((name) => typeof name === 'string' && name.length > 0)
  ) {
    return null
  }
  return {
    provider: r.provider as string,
    carrierId: r.carrierId as string,
    badgeId: r.badgeId as string,
    zoneId: r.zoneId as string,
    zoneName: r.zoneName as string,
    externalId: r.externalId as string,
    hostnames: hostnames as string[],
    scope: r.scope === 'wildcard' ? 'wildcard' : 'names',
    retiredAt: typeof r.retiredAt === 'string' ? r.retiredAt : null,
  }
}

/** True when every name is served by the certificate's names (a wildcard covers one label). */
export function certificateCoversAll(link: ProviderOriginLink, names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => coversHostname(link.hostnames, name))
}

/** The best ready origin certificate that covers a hostname, or null. */
export function pickOriginCertificate(rows: readonly TlsRow[], hostname: string): TlsRow | null {
  return findCoveringCertificate(rows, null, [hostname])
}

/**
 * A ready, unretired certificate of this carrier that already covers every name
 * and is not close to expiry: reused instead of issuing another. An exact
 * certificate wins over a wildcard; among equals the one that lasts longest.
 * With `carrierId` null any carrier counts.
 */
export function findCoveringCertificate(
  rows: readonly TlsRow[],
  carrierId: string | null,
  names: readonly string[],
  now: Date = new Date()
): TlsRow | null {
  const usable = rows.flatMap((row) => {
    if (row.source !== 'provider_origin' || row.status !== 'ready') return []
    const link = readProviderOrigin(row.metadata)
    if (link?.retiredAt !== null) return []
    if (carrierId !== null && link.carrierId !== carrierId) return []
    if (originCertificateIsDue(row.notAfter, now)) return []
    return certificateCoversAll(link, names) ? [{ row, link }] : []
  })
  usable.sort(
    (a, b) =>
      Number(a.link.scope === 'wildcard') - Number(b.link.scope === 'wildcard') ||
      a.link.hostnames.length - b.link.hostnames.length ||
      compareText(b.row.notAfter ?? '', a.row.notAfter ?? '')
  )
  return usable[0]?.row ?? null
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

/**
 * How many origin certificates removing a carrier (the whole account and all
 * its tokens) would strand. Removing one token is checked with the other
 * dependents (`badge-dependents.ts`): it strands only certificates no other
 * active token of the account can renew or revoke.
 */
export async function countOriginCertificatesFrom(
  db: Db,
  organizationId: string,
  from: { carrierId: string }
): Promise<number> {
  const rows = await listOriginCertificates(db, organizationId, from.carrierId)
  return rows.length
}

/** Ids of hostings that pin a certificate. */
export async function hostingsPinning(db: Db, tlsId: string): Promise<string[]> {
  const rows = await db.select({ id: hosting.id }).from(hosting).where(eq(hosting.tlsId, tlsId))
  return rows.map((row) => row.id)
}

/** A badge that can issue for the zone: it must have been proved to read the zone's certificates. */
export function badgeCoversZone(
  row: BadgeRow,
  zoneName: string
): { id: string; name: string } | null {
  const zones = toApiBadge(row).capabilities.certificates
  const wanted = zoneName.trim().toLowerCase()
  return zones.find((z) => z.name.toLowerCase() === wanted) ?? null
}

/**
 * The active tokens that can manage certificates for a zone, best first: the
 * shared selector, matched by the zone's id and narrowest first. Revoking and
 * renewing are NOT tied to the token that issued a certificate.
 */
export async function pickCertificateBadges(
  db: Db,
  carrierId: string,
  zone: { id: string; name: string }
): Promise<BadgeRow[]> {
  return pickBadges(await listBadges(db, carrierId), { capability: 'certificates', zone }).badges
}

type IssueParams = {
  db: Db
  secrets: DerivedSecretsConfig
  adapter: TunnelAdapter
  organizationId: string
  carrier: CarrierRow
  badge: BadgeRow
  zoneName: string
  /** Exact hostnames inside the zone; ignored for a wildcard, which always lists the zone and `*.` the zone. */
  names?: readonly string[]
  scope?: OriginCertificateScope
}

/**
 * The names a request lists: for a wildcard the zone and `*.` the zone, for the
 * default exact certificate the given hostnames, each the zone itself or a name
 * inside it, no wildcard, no repeats, at most the provider's limit.
 */
export function certificateRequestNames(
  zoneName: string,
  names: readonly string[] | undefined,
  scope: OriginCertificateScope
): string[] {
  const zone = zoneName.trim().toLowerCase()
  if (scope === 'wildcard') return originCertificateNames(zone)
  const exact = [...new Set((names ?? []).map((name) => name.trim().toLowerCase()))].sort(
    compareText
  )
  const problem = (reason: string) =>
    new OriginCertificateRefusal('origin_certificate_names', reason)
  if (exact.length === 0) throw problem('Give at least one hostname for the certificate')
  if (exact.length > MAX_ORIGIN_CERTIFICATE_NAMES) {
    throw problem(
      `A certificate can list at most ${MAX_ORIGIN_CERTIFICATE_NAMES} hostnames; this site has more`
    )
  }
  for (const name of exact) {
    if (name.includes('*')) {
      throw problem(
        'A wildcard needs the wildcard option; a certificate for hostnames lists exact names'
      )
    }
    if (!isValidHostname(name) || !(name === zone || name.endsWith(`.${zone}`))) {
      throw problem(`${name} is not a hostname inside ${zone}`)
    }
  }
  return exact
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
    // A certificate the provider no longer knows (or already revoked) is as good as revoked.
    if (err instanceof TunnelProviderError && err.code === 'not_found') return
    throw err
  }
}

/**
 * Ask the provider for a certificate and store it. The private key is made
 * here and never leaves this function except sealed into the row. If storing
 * fails after the provider issued the certificate, it is revoked again so
 * nothing is left behind.
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
  const scope = params.scope ?? 'names'
  const names = certificateRequestNames(zone.name, params.names, scope)
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
      hostnames: names,
      scope,
      retiredAt: null,
    }
    const [row] = await db
      .insert(tls)
      .values({
        organizationId,
        name: libraryName(names),
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

/** The library allows letters, digits, space, dot, underscore and hyphen in a certificate name. */
function libraryName(names: readonly string[]): string {
  const first = (names[0] ?? 'certificate').replace('*.', 'wildcard ')
  const more = names.length > 1 ? ` and ${names.length - 1} more` : ''
  return `Origin ${first}${more}`.slice(0, 255)
}

/** Write a link back into a row's metadata, leaving everything else in it alone. */
async function saveLink(db: Db, row: TlsRow, link: ProviderOriginLink): Promise<void> {
  const base = (row.metadata ?? {}) as Record<string, unknown>
  await db
    .update(tls)
    .set({ metadata: { ...base, providerOrigin: link } })
    .where(eq(tls.id, row.id))
}

/** Mark a certificate as no longer needed; it is revoked later by the sweep. Already retired stays as it was. */
async function retireRow(db: Db, row: TlsRow, now: Date): Promise<boolean> {
  const link = readProviderOrigin(row.metadata)
  if (link?.retiredAt !== null) return false
  await saveLink(db, row, { ...link, retiredAt: now.toISOString() })
  return true
}

export type EnsureResult = {
  row: TlsRow
  /** An existing certificate already covered every name, so nothing was issued. */
  reused: boolean
  /** Certificates this one replaces, now marked retired (not revoked yet). */
  retiredIds: string[]
}

/**
 * The certificate for these names: an existing one of this carrier that
 * already covers them (an exact certificate, or an opted-in wildcard) is
 * reused; otherwise a new one is issued and the exact certificates it makes
 * redundant are marked retired. Nothing is revoked here: the sites are pointed
 * at the new certificate first, and the sweep revokes the old one once no site
 * pins it.
 */
export async function ensureOriginCertificate(
  params: IssueParams & { now?: Date }
): Promise<EnsureResult> {
  const now = params.now ?? new Date()
  const scope = params.scope ?? 'names'
  const zone = params.zoneName.trim().toLowerCase()
  const wanted = scope === 'wildcard' ? originCertificateNames(zone) : [...(params.names ?? [])]
  const rows = await listOriginCertificates(params.db, params.organizationId, params.carrier.id)
  const sameZone = rows.filter((row) => readProviderOrigin(row.metadata)?.zoneName === zone)
  const covering = findCoveringCertificate(sameZone, params.carrier.id, wanted, now)
  if (covering && (scope === 'names' || isWildcardRow(covering))) {
    return { row: covering, reused: true, retiredIds: [] }
  }
  const row = await issueOriginCertificate(params)
  const link = readProviderOrigin(row.metadata)!
  const redundant = sameZone.filter((old) => isRedundantExact(old, link))
  const retired = await Promise.all(
    redundant.map(async (old) => ((await retireRow(params.db, old, now)) ? old.id : null))
  )
  return { row, reused: false, retiredIds: retired.filter((id): id is string => id !== null) }
}

function isWildcardRow(row: TlsRow): boolean {
  return readProviderOrigin(row.metadata)?.scope === 'wildcard'
}

/** An exact certificate whose names the new certificate also lists. */
function isRedundantExact(old: TlsRow, replacement: ProviderOriginLink): boolean {
  const oldLink = readProviderOrigin(old.metadata)
  return oldLink?.scope === 'names' && certificateCoversAll(replacement, oldLink.hostnames)
}

/**
 * Mark the certificates nobody needs any more as retired: none of the
 * hostnames still in use falls under them. `usedHostnames` is every hostname
 * of this organization that asks for a verified connection. Returns the ids.
 */
export async function retireUnusedOriginCertificates(
  db: Db,
  organizationId: string,
  usedHostnames: readonly string[],
  now: Date = new Date()
): Promise<string[]> {
  const rows = await listOriginCertificates(db, organizationId)
  const unused = rows.filter((row) => {
    const link = readProviderOrigin(row.metadata)
    return link?.retiredAt === null && !usedHostnames.some((n) => coversHostname(link.hostnames, n))
  })
  const retired = await Promise.all(
    unused.map(async (row) => ((await retireRow(db, row, now)) ? row.id : null))
  )
  return retired.filter((id): id is string => id !== null)
}

type RevokeParams = {
  db: Db
  secrets: DerivedSecretsConfig
  adapter: TunnelAdapter
  row: TlsRow
  /** Remove the row even when the provider cannot be reached or no token can revoke it. */
  force?: boolean
}

/**
 * Do `act` with the account's tokens for this zone, best first; the shared
 * helper takes a right off a token the provider refuses and tries the next.
 * Returns the first result with the token used, or `undefined` when no token
 * qualified or every one was refused.
 */
const failedWith = new WeakMap<object, string>()

/** The API token a failed call used, when it got as far as one (a provider that says "slow down" is per token). */
export function tokenOfFailure(err: unknown): string | null {
  return typeof err === 'object' && err !== null ? (failedWith.get(err) ?? null) : null
}

async function withZoneToken<R>(
  params: { db: Db; secrets: DerivedSecretsConfig },
  link: Pick<ProviderOriginLink, 'carrierId' | 'zoneId' | 'zoneName'>,
  act: (token: string, badgeRow: BadgeRow) => Promise<R>
): Promise<{ result: R; badgeId: string } | undefined> {
  try {
    const used = await useBadges(
      params.db,
      params.secrets,
      link.carrierId,
      { capability: 'certificates', zone: { id: link.zoneId, name: link.zoneName } },
      async (token, badgeRow) => {
        try {
          return await act(token, badgeRow)
        } catch (err) {
          if (typeof err === 'object' && err !== null) failedWith.set(err, badgeRow.id)
          throw err
        }
      }
    )
    return { result: used.value, badgeId: used.badge.id }
  } catch (err) {
    if (err instanceof BadgeUnavailable || err instanceof BadgeRefused) return undefined
    throw err
  }
}

/**
 * Revoke a certificate at the provider and remove the row. Refused while a
 * site pins it; the caller moves the site first. Only a certificate TurboPanel
 * issued has a link, so one it did not issue is never touched. Any active token
 * of the account with certificate rights for the zone may revoke it, not only
 * the one that issued it; the token used is returned so the caller can record it.
 */
export async function revokeOriginCertificate(
  params: RevokeParams
): Promise<{ revokedWithBadgeId: string | null }> {
  const { db, secrets, adapter, row } = params
  if ((await hostingsPinning(db, row.id)).length > 0) {
    throw new OriginCertificateRefusal('tls_in_use', 'A site still uses this certificate')
  }
  const link = readProviderOrigin(row.metadata)
  let usedBadgeId: string | null = null
  if (link && adapter.revokeOriginCertificate) {
    const done = await withZoneToken({ db, secrets }, link, (token) =>
      revokeAtProvider(adapter, token, link.externalId)
    )
    usedBadgeId = done?.badgeId ?? null
    if (usedBadgeId === null && !params.force) {
      throw new OriginCertificateRefusal(
        'badge_missing',
        'No active API Token can manage certificates for this zone, so the certificate cannot be revoked'
      )
    }
  }
  await db.delete(tls).where(eq(tls.id, row.id))
  return { revokedWithBadgeId: usedBadgeId }
}

export type RenewResult = {
  replacement: TlsRow
  /**
   * Sites now pinned to the replacement. Their web servers keep serving the
   * old certificate until the next deploy, so the caller (a surface that can
   * queue a hostings-only deploy) must push these; the old certificate stays
   * valid until its own expiry and is retired, not revoked, here.
   */
  repinnedHostingIds: string[]
}

/**
 * Replace a certificate that is close to expiry: issue a new one for the same
 * names and scope and re-point the sites that pinned the old one. The old row
 * is retired and goes once nothing pins it. Any active token with certificate
 * rights for the zone may issue it.
 */
export async function renewOriginCertificate(
  params: Omit<IssueParams, 'zoneName' | 'carrier' | 'badge' | 'names' | 'scope'> & {
    row: TlsRow
    now?: Date
  }
): Promise<RenewResult | null> {
  const link = readProviderOrigin(params.row.metadata)
  if (!link) return null
  const [carrierRow] = await params.db
    .select()
    .from(carrier)
    .where(and(eq(carrier.id, link.carrierId), eq(carrier.organizationId, params.organizationId)))
    .limit(1)
  if (!carrierRow) return null
  const issued = await withZoneToken(params, link, (_token, badgeRow) =>
    issueOriginCertificate({
      ...params,
      carrier: carrierRow,
      badge: badgeRow,
      zoneName: link.zoneName,
      names: link.hostnames,
      scope: link.scope,
    })
  )
  if (!issued) return null
  const replacement = issued.result
  const moved = await params.db
    .update(hosting)
    .set({ tlsId: replacement.id })
    .where(eq(hosting.tlsId, params.row.id))
    .returning({ id: hosting.id })
  await retireRow(params.db, params.row, params.now ?? new Date())
  return { replacement, repinnedHostingIds: moved.map((h) => h.id) }
}

export type OriginSweepResult = {
  renewed: string[]
  /** Sites the caller still has to push the new certificate to. */
  repinnedHostingIds: string[]
  /** Retired certificates revoked and removed (or removed after their own expiry). */
  removed: string[]
  failed: string[]
  /** 429 and 503 answers from the provider met in this pass. */
  throttled: ThrottleCounters
}

type SweepParams = {
  db: Db
  secrets: DerivedSecretsConfig
  registry: (provider: TunnelProvider) => TunnelAdapter
  organizationId: string
  /** Hostnames still asking for a verified connection; when given, certificates nothing needs are retired first. */
  usedHostnames?: readonly string[]
  /** Most rows handled in this pass; the rest wait for the next one. Defaults to ORIGIN_SWEEP_BATCH. */
  limit?: number
  now?: Date
}

/** What one pass did to one row. */
type SweepStep =
  | { kind: 'renewed'; id: string; repinned: string[] }
  | { kind: 'removed'; id: string }
  | { kind: 'failed'; id: string }
  | { kind: 'none' }

async function renewStep(
  params: SweepParams,
  adapter: TunnelAdapter,
  row: TlsRow,
  now: Date
): Promise<SweepStep> {
  const renewed = await renewOriginCertificate({
    db: params.db,
    secrets: params.secrets,
    adapter,
    organizationId: params.organizationId,
    row,
    now,
  })
  if (!renewed) {
    // No account or no token that can issue for the zone: a failure, so it backs off like one.
    throw new OriginCertificateRefusal(
      'badge_missing',
      'No active API Token can issue certificates for this zone'
    )
  }
  return { kind: 'renewed', id: renewed.replacement.id, repinned: renewed.repinnedHostingIds }
}

/** The work for one row that is not waiting: renew, drop an expired one, or revoke a retired one. */
async function sweepRowWork(
  params: SweepParams,
  adapter: TunnelAdapter,
  row: TlsRow,
  link: ProviderOriginLink,
  now: Date
): Promise<SweepStep> {
  // A certificate a site still pins stays renewable even when it is retired
  // (verification turned off), so the server never serves an expired one.
  if ((await hostingsPinning(params.db, row.id)).length > 0) {
    return originCertificateIsDue(row.notAfter, now)
      ? await renewStep(params, adapter, row, now)
      : { kind: 'none' }
  }
  if (link.retiredAt === null) return { kind: 'none' }
  if (row.notAfter !== null && Date.parse(row.notAfter) <= now.getTime()) {
    await params.db.delete(tls).where(eq(tls.id, row.id))
    return { kind: 'removed', id: row.id }
  }
  const waitedMs = now.getTime() - Date.parse(link.retiredAt)
  if (waitedMs < ORIGIN_CERTIFICATE_RETIRE_GRACE_HOURS * MS_PER_HOUR) return { kind: 'none' }
  await revokeOriginCertificate({ db: params.db, secrets: params.secrets, adapter, row })
  return { kind: 'removed', id: row.id }
}

/**
 * Remember a failure on the row. A provider that said how long to wait also
 * holds back every other row of the same API token for that long, in this pass
 * (`paused`) and in later ones.
 */
async function recordFailure(
  params: SweepParams,
  row: TlsRow,
  link: ProviderOriginLink,
  err: unknown,
  now: Date,
  paused: Set<string>
): Promise<void> {
  try {
    const retry = nextOriginRetry(readOriginRetry(row.metadata), err, now)
    await saveOriginRetry(params.db, row.id, retry)
    const wait = throttleWait(err)
    if (wait === null || retry.nextTryAt === null) return
    const badgeId = tokenOfFailure(err) ?? link.badgeId
    paused.add(badgeId)
    const until = new Date(retry.nextTryAt)
    const siblings = (await listOriginCertificates(params.db, params.organizationId)).filter(
      (other) => other.id !== row.id && readProviderOrigin(other.metadata)?.badgeId === badgeId
    )
    await mapSequential(siblings, (other) => pauseOriginRow(params.db, other, until))
  } catch (saveErr) {
    logWarn('tls', `origin certificate back-off was not saved: ${String(saveErr)}`)
  }
}

async function sweepRow(
  params: SweepParams,
  row: TlsRow,
  now: Date,
  paused: Set<string>,
  throttled: ThrottleCounters
): Promise<SweepStep> {
  const link = readProviderOrigin(row.metadata)
  if (!link || paused.has(link.badgeId)) return { kind: 'none' }
  const adapter = params.registry(link.provider as TunnelProvider)
  try {
    const step = await sweepRowWork(params, adapter, row, link, now)
    if (step.kind === 'renewed') await saveOriginRetry(params.db, row.id, null)
    return step
  } catch (err) {
    if (err instanceof TunnelProviderError) countThrottle(throttled, 'cloudflare', err.status)
    await recordFailure(params, row, link, err, now, paused)
    return { kind: 'failed', id: row.id }
  }
}

/** The certificate that ends soonest goes first (one with no end date, first of all). */
function byDueTime(a: TlsRow, b: TlsRow): number {
  const end = (row: TlsRow) => (row.notAfter ? Date.parse(row.notAfter) : Number.NEGATIVE_INFINITY)
  return end(a) - end(b)
}

/** Rows one pass handles at most (each can cost a provider call), soonest due first. */
export const ORIGIN_SWEEP_BATCH = 10

/** Rows a pass can do something with: retired ones, and live ones close to expiry, unless they are waiting out a failure. */
function needsSweep(row: TlsRow, now: Date): boolean {
  const link = readProviderOrigin(row.metadata)
  if (link === null || originRetryWaiting(row.metadata, now)) return false
  return link.retiredAt !== null || originCertificateIsDue(row.notAfter, now)
}

/**
 * One pass over an organization's origin certificates: renew those that are
 * pinned and close to expiry, and clear those that were retired: revoked at
 * the provider once no site pins them and the grace period has passed, or just
 * dropped once expired (an expired certificate needs no revoking). A failure on
 * one row is recorded with a back-off (an hour, doubling to a day, or the time
 * the provider asked for) and does not stop the others.
 */
export async function sweepOriginCertificates(params: SweepParams): Promise<OriginSweepResult> {
  const now = params.now ?? new Date()
  if (params.usedHostnames) {
    await retireUnusedOriginCertificates(
      params.db,
      params.organizationId,
      params.usedHostnames,
      now
    )
  }
  const rows = (await listOriginCertificates(params.db, params.organizationId))
    .filter((row) => needsSweep(row, now))
    .sort(byDueTime)
    .slice(0, params.limit ?? ORIGIN_SWEEP_BATCH)
  const paused = new Set<string>()
  const throttled = emptyThrottleCounters()
  const steps = await mapSequential(rows, (row) => sweepRow(params, row, now, paused, throttled))
  const result: OriginSweepResult = {
    renewed: [],
    repinnedHostingIds: [],
    removed: [],
    failed: [],
    throttled,
  }
  for (const step of steps) {
    if (step.kind === 'renewed') {
      result.renewed.push(step.id)
      result.repinnedHostingIds.push(...step.repinned)
    } else if (step.kind === 'removed') {
      result.removed.push(step.id)
    } else if (step.kind === 'failed') {
      result.failed.push(step.id)
    }
  }
  return result
}

/** A certificate the provider holds for a zone, with what TurboPanel knows about it. */
export type ExistingOriginCertificate = {
  externalId: string
  hostnames: string[]
  notAfter: string | null
  /** TurboPanel issued it, so it holds the private key and can install and revoke it. */
  issuedHere: boolean
  /** The certificate library row, when TurboPanel issued it. */
  tlsId: string | null
  retired: boolean
  /** It lists the zone's wildcard name, so it can serve any site one label below the zone. */
  wildcard: boolean
  /** Plain words about whether it can be used. */
  note: string
}

const FOREIGN_NOTE =
  'Created outside TurboPanel. The private key stays with whoever made it, so TurboPanel cannot install it. To use it, upload its certificate and key to the certificate library, or issue a new one here. TurboPanel never revokes a certificate it did not issue.'

/**
 * The provider's certificates for a zone next to the ones TurboPanel issued.
 * The provider's list carries the certificate and its names but never a private
 * key, so only a certificate TurboPanel made (its key is sealed in the library)
 * can be installed on a server.
 */
export function describeExistingOriginCertificates(
  provider: readonly ProviderOriginCertificate[],
  rows: readonly TlsRow[],
  zoneName: string
): ExistingOriginCertificate[] {
  const zone = zoneName.trim().toLowerCase()
  const ours = new Map<string, TlsRow>()
  for (const row of rows) {
    const link = readProviderOrigin(row.metadata)
    if (link) ours.set(link.externalId, row)
  }
  return provider
    .map((item) => {
      const row = ours.get(item.externalId) ?? null
      const link = row ? readProviderOrigin(row.metadata) : null
      return {
        externalId: item.externalId,
        hostnames: [...item.hostnames].sort(compareText),
        notAfter: item.notAfter,
        issuedHere: row !== null,
        tlsId: row?.id ?? null,
        retired: link?.retiredAt != null,
        wildcard: item.hostnames.some((name) => name.toLowerCase() === `*.${zone}`),
        note: row
          ? 'Issued by TurboPanel. Its key is kept sealed in the certificate library.'
          : FOREIGN_NOTE,
      }
    })
    .sort((a, b) => compareText(a.hostnames[0] ?? '', b.hostnames[0] ?? ''))
}
