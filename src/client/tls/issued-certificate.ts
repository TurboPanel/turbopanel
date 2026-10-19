/**
 * Store the certificate and private key Caddy issued on a serving host.
 *
 * The daemon sends the pair for one hostname (`POST /api/daemon/v1/tls/issued`)
 * after a first sighting, a daemon restart or a renewal. Everything is checked
 * before anything is written, in this order: the pair itself (parses, covers
 * the hostname, not expired, not self-signed, the key matches), then who sent it
 * (the reporting server belongs to an organization that still allows Let's
 * Encrypt, and a hosting placed on that server pins the row). The key is sealed
 * with the same envelope as every other certificate key and is never returned,
 * logged or audited.
 *
 * Writes `certificate_pem`, `private_key_pem`, `not_after`,
 * `fingerprint_sha256` and the parsed details (start date, issuer, subject).
 * Never writes `tls.status`: as `acme-issuance-event.ts` explains, a
 * visibility feature must not become a second deploy gate.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, hosting, server, service, tls } from '../../db/schema.ts'
import { recordAudit } from '../../features/audit/audit-records.ts'
import { loadAcmeEnabled } from '../hostings/letsencrypt-store.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { coversHostname, normalizeHostname } from '../../lib/tls/match.ts'
import { PemError, splitCertificateChain } from '../../lib/tls/pem.ts'
import { privateKeyMatchesCertificate, TlsKeyError } from '../../lib/tls/keys.ts'
import { CertificateParseError, parseCertificatePem } from '../../lib/tls/parse.ts'
import type { ParsedCertificate, TlsAcmeMetadata } from '../../lib/tls/types.ts'
import { assertTpSecretPrivateKey } from './routes-helpers.ts'

/** A chain longer than this is not an ordinary leaf plus intermediates. */
export const MAX_ISSUED_CHAIN_CERTIFICATES = 6
export const MAX_ISSUED_CHAIN_CHARS = 32 * 1024
export const MAX_ISSUED_KEY_CHARS = 8 * 1024

export type IssuedCertificateInput = {
  /** The server that reported the pair (from its daemon token, never the body). */
  serverId: string
  hostname: string
  certificatePem: string
  privateKeyPem: string
}

export type IssuedCertificateRefusal =
  | 'invalid_hostname'
  | 'invalid_certificate'
  | 'key_mismatch'
  | 'certificate_expired'
  | 'certificate_not_for_hostname'
  | 'self_signed_certificate'
  | 'server_not_in_organization'
  | 'acme_disabled'
  | 'no_matching_certificate'

export type IssuedCertificateResult =
  | { ok: true; stored: boolean; tlsIds: string[] }
  | {
      ok: false
      error: IssuedCertificateRefusal
      status: 400 | 403 | 404 | 409
    }

const REFUSAL_STATUS: Record<IssuedCertificateRefusal, 400 | 403 | 404 | 409> = {
  invalid_hostname: 400,
  invalid_certificate: 400,
  key_mismatch: 400,
  certificate_expired: 400,
  certificate_not_for_hostname: 400,
  self_signed_certificate: 400,
  server_not_in_organization: 403,
  acme_disabled: 409,
  no_matching_certificate: 404,
}

function refuse(error: IssuedCertificateRefusal): IssuedCertificateResult {
  return { ok: false, error, status: REFUSAL_STATUS[error] }
}

export type IssuedCertificateDeps = {
  /** Sealing secrets (`data-encryption` purpose). */
  dataEncryptionSecrets: DerivedSecretsConfig
  now?: () => Date
}

type ManagedRowMetadata = {
  dnsNames: string[]
  acme?: TlsAcmeMetadata
  [key: string]: unknown
}

function isManagedRowMetadata(value: unknown): value is ManagedRowMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return Array.isArray(record.dnsNames) && record.dnsNames.every((n) => typeof n === 'string')
}

/** Only a plain lowercase DNS name: no wildcard, no label separator tricks. */
function isPlainHostname(hostname: string): boolean {
  return (
    hostname.length > 0 &&
    hostname.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(hostname)
  )
}

async function checkPair(
  input: IssuedCertificateInput,
  hostname: string,
  now: Date
): Promise<
  | { ok: true; parsed: ParsedCertificate }
  | {
      ok: false
      error: IssuedCertificateRefusal
    }
> {
  let chain: string[]
  try {
    chain = splitCertificateChain(input.certificatePem)
  } catch (err) {
    if (err instanceof PemError) {
      return { ok: false, error: 'invalid_certificate' }
    }
    throw err
  }
  if (
    chain.length === 0 ||
    chain.length > MAX_ISSUED_CHAIN_CERTIFICATES ||
    input.certificatePem.length > MAX_ISSUED_CHAIN_CHARS ||
    input.privateKeyPem.length > MAX_ISSUED_KEY_CHARS
  ) {
    return { ok: false, error: 'invalid_certificate' }
  }
  let parsed: ParsedCertificate
  try {
    parsed = await parseCertificatePem(input.certificatePem)
  } catch (err) {
    if (err instanceof CertificateParseError) {
      return { ok: false, error: 'invalid_certificate' }
    }
    throw err
  }
  if (!coversHostname(parsed.dnsNames, hostname)) {
    return { ok: false, error: 'certificate_not_for_hostname' }
  }
  if (parsed.notAfter.getTime() <= now.getTime()) {
    return { ok: false, error: 'certificate_expired' }
  }
  if (parsed.subject === parsed.issuer) {
    return { ok: false, error: 'self_signed_certificate' }
  }
  try {
    if (!(await privateKeyMatchesCertificate(input.privateKeyPem, parsed))) {
      return { ok: false, error: 'key_mismatch' }
    }
  } catch (err) {
    if (err instanceof TlsKeyError) {
      return { ok: false, error: 'invalid_certificate' }
    }
    throw err
  }
  return { ok: true, parsed }
}

/**
 * Whether the pair should replace what the row holds. A row with nothing yet
 * takes it. A renewal (same names) replaces the old pair. A certificate for a
 * different name of a multi-name row (Caddy issues one per name) does not
 * overwrite a still-valid pair for another name.
 */
function replaces(
  previous: TlsAcmeMetadata | undefined,
  hasStoredPair: boolean,
  parsed: ParsedCertificate,
  now: Date
): boolean {
  if (!hasStoredPair) return true
  const storedNames = previous?.storedNames
  if (storedNames === undefined) return true
  const sameNames =
    storedNames.length === parsed.dnsNames.length &&
    storedNames.every((name) => parsed.dnsNames.includes(name))
  if (sameNames) return true
  const storedNotAfter = previous?.notAfter === undefined ? 0 : Date.parse(previous.notAfter)
  return !(storedNotAfter > now.getTime())
}

export async function storeIssuedCertificate(
  db: Db,
  input: IssuedCertificateInput,
  deps: IssuedCertificateDeps
): Promise<IssuedCertificateResult> {
  const now = (deps.now ?? (() => new Date()))()
  const hostname = normalizeHostname(input.hostname)
  if (!isPlainHostname(hostname)) return refuse('invalid_hostname')

  const checked = await checkPair(input, hostname, now)
  if (!checked.ok) return refuse(checked.error)
  const { parsed } = checked

  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, input.serverId))
    .limit(1)
  const organizationId = serverRow?.organizationId
  if (!organizationId) return refuse('server_not_in_organization')
  if (!(await loadAcmeEnabled(db, organizationId))) {
    return refuse('acme_disabled')
  }

  const candidates = (
    await db
      .select({
        id: tls.id,
        status: tls.status,
        metadata: tls.metadata,
        fingerprintSha256: tls.fingerprintSha256,
        // Only whether a key is already stored; the sealed value is never read here.
        hasKey: sql<boolean>`${tls.privateKeyPem} is not null`,
      })
      .from(tls)
      .where(and(eq(tls.source, 'lets_encrypt'), eq(tls.organizationId, organizationId)))
  ).filter(
    (row) =>
      row.status === 'managed' &&
      isManagedRowMetadata(row.metadata) &&
      coversHostname(row.metadata.dnsNames, hostname)
  )
  if (candidates.length === 0) return refuse('no_matching_certificate')

  // A daemon may only supply the certificate of a hosting placed on its own
  // server; a pin on any other server's hosting is none of its business.
  const pinned = await db
    .select({ tlsId: hosting.tlsId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .where(
      and(
        eq(environment.serverId, input.serverId),
        inArray(
          hosting.tlsId,
          candidates.map((row) => row.id)
        )
      )
    )
  const pinnedIds = new Set(pinned.map((row) => row.tlsId))
  const rows = candidates.filter((row) => pinnedIds.has(row.id))
  if (rows.length === 0) return refuse('no_matching_certificate')

  const sealedKey = await encryptSecret(deps.dataEncryptionSecrets, input.privateKeyPem)
  assertTpSecretPrivateKey(sealedKey)

  const storedIds: string[] = []
  await forEachSequential(rows, async (row) => {
    const metadata = row.metadata as ManagedRowMetadata
    const hasStoredPair = row.hasKey === true
    if (hasStoredPair && row.fingerprintSha256 === parsed.fingerprintSha256) {
      return
    }
    if (!replaces(metadata.acme, hasStoredPair, parsed, now)) return

    // The fingerprint is unique within an organization: the same certificate
    // already held by another row is not an error, the column is just left
    // empty here.
    const [duplicate] = await db
      .select({ id: tls.id })
      .from(tls)
      .where(
        and(
          eq(tls.organizationId, organizationId),
          eq(tls.fingerprintSha256, parsed.fingerprintSha256),
          ne(tls.id, row.id)
        )
      )
      .limit(1)

    const acme: TlsAcmeMetadata = {
      ...metadata.acme,
      notAfter: parsed.notAfter.toISOString(),
      lastIssuedAt: now.toISOString(),
      storedNames: parsed.dnsNames,
      issuedByServerId: input.serverId,
    }
    delete acme.lastError
    await db
      .update(tls)
      .set({
        certificatePem: input.certificatePem,
        privateKeyPem: sealedKey,
        notAfter: parsed.notAfter.toISOString(),
        fingerprintSha256: duplicate ? null : parsed.fingerprintSha256,
        issuedByServerId: input.serverId,
        metadata: {
          ...metadata,
          hasWildcard: parsed.hasWildcard,
          notBefore: parsed.notBefore.toISOString(),
          subject: parsed.subject,
          issuer: parsed.issuer,
          acme,
        },
        updatedAt: now.toISOString(),
      })
      .where(and(eq(tls.id, row.id), eq(tls.organizationId, organizationId)))
    storedIds.push(row.id)
    await recordAudit(db, {
      organizationId,
      actorUserId: null,
      action: 'tls.certificate.store',
      targetType: 'tls',
      targetId: row.id,
      context: {
        hostname,
        serverId: input.serverId,
        fingerprintSha256: parsed.fingerprintSha256,
        notAfter: parsed.notAfter.toISOString(),
      },
    })
  })
  return { ok: true, stored: storedIds.length > 0, tlsIds: storedIds }
}
