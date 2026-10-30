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
import { normalizePrivateKeyPem, PemError, splitCertificateChain } from '../../lib/tls/pem.ts'
import { privateKeyMatchesCertificate, TlsKeyError } from '../../lib/tls/keys.ts'
import { CertificateParseError, parseCertificatePem } from '../../lib/tls/parse.ts'
import type { ParsedCertificate, TlsAcmeMetadata } from '../../lib/tls/types.ts'
import { publicMarker } from '../../features/tls/http-issuance/progress.ts'
import {
  afterCapture,
  canAcceptCapture,
  readHttpIssuanceState,
  withHttpIssuanceState,
} from '../../features/tls/http-issuance/state.ts'
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
  /**
   * The open order this pair answers (`acme-issue-request`). Absent: the pair
   * is a server's own order, accepted only from a server that holds a pin.
   * Present: accepted only from the server that was asked, for a row holding
   * that open request.
   */
  requestId?: string
}

export type IssuedCertificateRefusal =
  | 'invalid_hostname'
  | 'invalid_certificate'
  | 'invalid_private_key'
  | 'key_mismatch'
  | 'certificate_expired'
  | 'certificate_not_for_hostname'
  | 'self_signed_certificate'
  | 'server_not_in_organization'
  | 'acme_disabled'
  | 'no_matching_certificate'
  | 'request_not_open'

export type IssuedCertificateResult =
  | { ok: true; stored: boolean; tlsIds: string[] }
  | {
      ok: false
      error: IssuedCertificateRefusal
      message: string
      status: 400 | 403 | 404 | 409
    }

const REFUSAL_STATUS: Record<IssuedCertificateRefusal, 400 | 403 | 404 | 409> = {
  invalid_hostname: 400,
  invalid_certificate: 400,
  invalid_private_key: 400,
  key_mismatch: 400,
  certificate_expired: 400,
  certificate_not_for_hostname: 400,
  self_signed_certificate: 400,
  server_not_in_organization: 403,
  acme_disabled: 409,
  no_matching_certificate: 404,
  request_not_open: 404,
}

/** Plain words for each refusal, never carrying any part of the pair. */
export const REFUSAL_MESSAGE: Record<IssuedCertificateRefusal, string> = {
  invalid_hostname: 'The hostname is not a plain DNS name.',
  invalid_certificate:
    'The certificate chain could not be read, has no certificate, or is longer than allowed.',
  invalid_private_key:
    'The private key could not be read: it is not an RSA (PKCS#1 or PKCS#8), EC (SEC1 or PKCS#8, curve P-256, P-384 or P-521) or Ed25519 (PKCS#8) key, or it is too large.',
  key_mismatch:
    'The private key does not belong to the first certificate in the chain (a different key or a different kind of key).',
  certificate_expired: 'The certificate has already expired.',
  certificate_not_for_hostname: 'The certificate does not cover the hostname.',
  self_signed_certificate: 'The certificate is self-signed.',
  server_not_in_organization: 'The sending server does not belong to an organization.',
  acme_disabled: "Let's Encrypt is turned off for the organization.",
  no_matching_certificate:
    "No managed Let's Encrypt certificate for this hostname is pinned by a site on the sending server.",
  request_not_open:
    'No open certificate request with this id was made to the sending server for this hostname.',
}

function refuse(error: IssuedCertificateRefusal): IssuedCertificateResult {
  return { ok: false, error, message: REFUSAL_MESSAGE[error], status: REFUSAL_STATUS[error] }
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

type Refused = { ok: false; error: IssuedCertificateRefusal }

const refused = (error: IssuedCertificateRefusal): Refused => ({ ok: false, error })

/** The chain must read as PEM, hold 1 to 6 certificates and stay within the size cap. */
function chainShapeProblem(certificatePem: string): Refused | null {
  let chain: string[]
  try {
    chain = splitCertificateChain(certificatePem)
  } catch (err) {
    if (err instanceof PemError) return refused('invalid_certificate')
    throw err
  }
  const tooLong = chain.length === 0 || chain.length > MAX_ISSUED_CHAIN_CERTIFICATES
  return tooLong || certificatePem.length > MAX_ISSUED_CHAIN_CHARS
    ? refused('invalid_certificate')
    : null
}

/**
 * Caddy writes ECDSA keys as SEC1 and RSA keys as PKCS#1; store every key as
 * PKCS#8, the form the rest of the TLS library works with.
 */
function readPrivateKey(privateKeyPem: string): { ok: true; pem: string } | Refused {
  try {
    if (privateKeyPem.length > MAX_ISSUED_KEY_CHARS) throw new PemError('key too large')
    return { ok: true, pem: normalizePrivateKeyPem(privateKeyPem) }
  } catch (err) {
    if (err instanceof PemError || err instanceof DOMException) {
      return refused('invalid_private_key')
    }
    throw err
  }
}

async function readLeaf(
  certificatePem: string
): Promise<{ ok: true; parsed: ParsedCertificate } | Refused> {
  try {
    return { ok: true, parsed: await parseCertificatePem(certificatePem) }
  } catch (err) {
    if (err instanceof CertificateParseError) return refused('invalid_certificate')
    throw err
  }
}

/** Name, expiry and self-signed checks on the leaf. */
function leafProblem(parsed: ParsedCertificate, hostname: string, now: Date): Refused | null {
  if (!coversHostname(parsed.dnsNames, hostname)) return refused('certificate_not_for_hostname')
  if (parsed.notAfter.getTime() <= now.getTime()) return refused('certificate_expired')
  if (parsed.subject === parsed.issuer) return refused('self_signed_certificate')
  return null
}

async function keyMismatch(privateKeyPem: string, parsed: ParsedCertificate): Promise<boolean> {
  try {
    return !(await privateKeyMatchesCertificate(privateKeyPem, parsed))
  } catch (err) {
    // The key was read fine before, so a failure here means it is a different
    // kind of key (or curve) from the one the certificate carries.
    if (err instanceof TlsKeyError) return true
    throw err
  }
}

async function checkPair(
  input: IssuedCertificateInput,
  hostname: string,
  now: Date
): Promise<{ ok: true; parsed: ParsedCertificate; privateKeyPem: string } | Refused> {
  const shape = chainShapeProblem(input.certificatePem)
  if (shape) return shape
  const key = readPrivateKey(input.privateKeyPem)
  if (!key.ok) return key
  const leaf = await readLeaf(input.certificatePem)
  if (!leaf.ok) return leaf
  const problem = leafProblem(leaf.parsed, hostname, now)
  if (problem) return problem
  if (await keyMismatch(key.pem, leaf.parsed)) return refused('key_mismatch')
  return { ok: true, parsed: leaf.parsed, privateKeyPem: key.pem }
}

/**
 * Whether the pair should replace what the row holds. A row with nothing yet
 * takes it. After that a pair replaces the stored one only when it expires
 * later (a renewal): an older valid pair sent again, or one with the very same
 * expiry, never overwrites a newer one. A certificate for a different name of
 * a multi-name row (Caddy issues one per name) does not overwrite a
 * still-valid pair for another name.
 */
export function replaces(
  stored: { names: string[] | undefined; notAfter: string | null },
  hasStoredPair: boolean,
  parsed: ParsedCertificate,
  now: Date
): boolean {
  if (!hasStoredPair) return true
  const storedNotAfter = stored.notAfter === null ? Number.NaN : Date.parse(stored.notAfter)
  if (Number.isNaN(storedNotAfter)) return true
  const sameNames =
    stored.names === undefined ||
    (stored.names.length === parsed.dnsNames.length &&
      stored.names.every((name) => parsed.dnsNames.includes(name)))
  if (sameNames) return parsed.notAfter.getTime() > storedNotAfter
  return storedNotAfter <= now.getTime()
}

type StoreOutcome = { refusal: IssuedCertificateRefusal } | { stored: StoredRow[] }

type StoredRow = { id: string; hostname: string }

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
  const { parsed, privateKeyPem } = checked

  const [serverRow] = await db
    .select({ organizationId: server.organizationId })
    .from(server)
    .where(eq(server.id, input.serverId))
    .limit(1)
  const organizationId = serverRow?.organizationId
  if (!organizationId) return refuse('server_not_in_organization')

  const sealedKey = await encryptSecret(deps.dataEncryptionSecrets, privateKeyPem)
  assertTpSecretPrivateKey(sealedKey)

  // One transaction under the organization row lock, the same lock the
  // Let's Encrypt setting takes: turning Let's Encrypt off and storing a pair
  // cannot interleave and leave a key behind. The matching rows are locked
  // too, so their metadata is read and rewritten without a concurrent change
  // slipping in between.
  const outcome: StoreOutcome = await db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db
    await tx.execute(sql`select id from organization where id = ${organizationId} for update`)
    if (!(await loadAcmeEnabled(tx, organizationId))) {
      return { refusal: 'acme_disabled' as const }
    }
    return await writePair(tx, { organizationId, hostname, sealedKey, parsed, now, input })
  })
  if ('refusal' in outcome) return refuse(outcome.refusal)

  await forEachSequential(outcome.stored, (row) =>
    recordAudit(db, {
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
  )
  return { ok: true, stored: outcome.stored.length > 0, tlsIds: outcome.stored.map((r) => r.id) }
}

/** Whether the row holds the open request this pair answers, asked of the reporting server. */
function requestIsOpenFor(metadata: unknown, input: IssuedCertificateInput, now: Date): boolean {
  return (
    canAcceptCapture(readHttpIssuanceState(metadata), {
      serverId: input.serverId,
      requestId: input.requestId ?? '',
      now,
    }).ok === true
  )
}

/**
 * A daemon may only supply the certificate of a hosting placed on its own
 * server; a pin on any other server's hosting is none of its business.
 */
async function rowsPinnedOnServer<T extends { id: string }>(
  tx: Db,
  candidates: T[],
  serverId: string
): Promise<T[]> {
  const pinned = await tx
    .select({ tlsId: hosting.tlsId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .innerJoin(environment, eq(environment.id, service.environmentId))
    .where(
      and(
        eq(environment.serverId, serverId),
        inArray(
          hosting.tlsId,
          candidates.map((row) => row.id)
        )
      )
    )
  const pinnedIds = new Set(pinned.map((row) => row.tlsId))
  return candidates.filter((row) => pinnedIds.has(row.id))
}

/**
 * The row's metadata after a pair arrived for its open request: the request
 * notes the pair (and closes if the issuing server already said `issued`), and
 * the public marker follows.
 */
function withCapturedRequest(metadata: ManagedRowMetadata, now: Date): Record<string, unknown> {
  const state = readHttpIssuanceState(metadata)
  if (!state) return metadata
  const after = afterCapture(state, now)
  return {
    ...withHttpIssuanceState(metadata, after),
    acme: publicMarker(metadata.acme, after),
  }
}

async function writePair(
  tx: Db,
  params: {
    organizationId: string
    hostname: string
    sealedKey: string
    parsed: ParsedCertificate
    now: Date
    input: IssuedCertificateInput
  }
): Promise<StoreOutcome> {
  const { organizationId, hostname, sealedKey, parsed, now, input } = params
  const candidates = (
    await tx
      .select({
        id: tls.id,
        status: tls.status,
        metadata: tls.metadata,
        notAfter: tls.notAfter,
        fingerprintSha256: tls.fingerprintSha256,
        // Only whether a key is already stored; the sealed value is never read here.
        hasKey: sql<boolean>`${tls.privateKeyPem} is not null`,
      })
      .from(tls)
      .where(and(eq(tls.source, 'lets_encrypt'), eq(tls.organizationId, organizationId)))
      .for('update')
  ).filter(
    (row) =>
      row.status === 'automatic' &&
      isManagedRowMetadata(row.metadata) &&
      coversHostname(row.metadata.dnsNames, hostname)
  )
  if (candidates.length === 0) return { refusal: 'no_matching_certificate' }

  const rows = input.requestId
    ? candidates.filter((row) => requestIsOpenFor(row.metadata, input, now))
    : await rowsPinnedOnServer(tx, candidates, input.serverId)
  if (rows.length === 0) {
    return { refusal: input.requestId ? 'request_not_open' : 'no_matching_certificate' }
  }

  const stored: StoredRow[] = []
  await forEachSequential(rows, async (row) => {
    const metadata = row.metadata as ManagedRowMetadata
    const hasStoredPair = row.hasKey === true
    if (hasStoredPair && row.fingerprintSha256 === parsed.fingerprintSha256) return
    const storedNames = hasStoredPair ? metadata.acme?.storedNames : undefined
    if (!replaces({ names: storedNames, notAfter: row.notAfter }, hasStoredPair, parsed, now)) {
      return
    }

    // The fingerprint is unique within an organization: the same certificate
    // already held by another row is not an error, the column is just left
    // empty here.
    const [duplicate] = await tx
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
    const nextMetadata = {
      ...metadata,
      hasWildcard: parsed.hasWildcard,
      notBefore: parsed.notBefore.toISOString(),
      subject: parsed.subject,
      issuer: parsed.issuer,
      acme,
    }
    await tx
      .update(tls)
      .set({
        certificatePem: input.certificatePem,
        privateKeyPem: sealedKey,
        notAfter: parsed.notAfter.toISOString(),
        fingerprintSha256: duplicate ? null : parsed.fingerprintSha256,
        issuedByServerId: input.serverId,
        metadata: input.requestId ? withCapturedRequest(nextMetadata, now) : nextMetadata,
        updatedAt: now.toISOString(),
      })
      .where(and(eq(tls.id, row.id), eq(tls.organizationId, organizationId)))
    stored.push({ id: row.id, hostname })
  })
  return { stored }
}
