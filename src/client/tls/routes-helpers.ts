import { plainCertificateFailure } from '../../features/hostings/acme-failure-text.ts'
import { isLoopbackOrPrivateHostname } from '../../features/install/install-tls.ts'
import {
  encryptSecret,
  ENVELOPE_MAGIC,
  isSealedEnvelope,
} from '../../lib/secrets/data-encryption.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  assembleTlsMetadata,
  metadataFromParsed,
  mintOrganizationCa,
  mintSelfSignedCertificate,
  normalizePrivateKeyPem,
  parseCertificatePem,
  parseTlsOptions,
  privateKeyMatchesCertificate,
  refreshTlsStatus,
  splitCertificateChain,
  TLS_SOURCES,
  type TlsMetadata,
  type TlsOptions,
  type TlsSource,
} from '../../lib/tls/index.ts'
import { isUniqueViolationOn } from '../../db/unique-violation.ts'
import {
  isOrganizationCaUniqueViolation,
  type TlsRowForPublic,
} from '../../features/tls/organization-ca.ts'

export { isPostgresUniqueViolation } from '../../db/unique-violation.ts'
export { isOrganizationCaUniqueViolation, type TlsRowForPublic }

export const TLS_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isTlsUuid(value: string): boolean {
  return TLS_UUID_RE.test(value)
}

/**
 * The metadata a response carries. A row that has no certificate yet stores an
 * epoch placeholder for its dates; those two go out as `null` (not as 1970,
 * which a browser in the Americas shows as 12/31/1969).
 */
export type TlsPublicMetadata = Omit<TlsMetadata, 'notBefore' | 'notAfter'> & {
  notBefore: string | null
  notAfter: string | null
}

export type TlsPublicRow = {
  id: string
  name: string | null
  source: string
  organizationId: string
  metadata: TlsPublicMetadata
  options: TlsOptions | null
  certificatePem: string | null
  /**
   * Active+retired Organization CA PEM bundle. Present on GET /tls/ca only —
   * list/detail rows omit it. Signing still uses `certificatePem` (active).
   */
  trustBundlePem?: string
  /**
   * Organization CA generation. Present on Organization CA rows; `null` for
   * other library certificates.
   */
  caGeneration?: number | null
  createdAt: string
  updatedAt: string
}

/** True for the epoch a not-yet-issued row stores in place of a date. */
function isPlaceholderDate(value: string): boolean {
  const time = Date.parse(value)
  return Number.isNaN(time) || time <= 0
}

export function publicTlsMetadata(
  metadata: TlsMetadata,
  hasCertificate: boolean
): TlsPublicMetadata {
  if (hasCertificate) return metadata
  return {
    ...metadata,
    notBefore: isPlaceholderDate(metadata.notBefore) ? null : metadata.notBefore,
    notAfter: isPlaceholderDate(metadata.notAfter) ? null : metadata.notAfter,
  }
}

/**
 * The issuance note a row shows: the server's own failed check in plain words
 * (rows stored before that mapping still hold the raw text), and none once a
 * certificate was issued after the last recorded failure.
 */
export function plainAcmeNote<T extends { acme?: { lastError?: string } }>(metadata: T): T {
  const acme = metadata.acme as
    { lastError?: string; lastIssuedAt?: string; lastFailedAt?: string } | undefined
  if (acme?.lastError === undefined) return metadata
  const issued = Date.parse(acme.lastIssuedAt ?? '')
  const failed = Date.parse(acme.lastFailedAt ?? '')
  const settled = !Number.isNaN(issued) && !Number.isNaN(failed) && issued > failed
  const { lastError, ...rest } = acme
  return {
    ...metadata,
    acme: settled ? rest : { ...rest, lastError: plainCertificateFailure(lastError) },
  }
}

export function toPublicTlsRow(
  row: TlsRowForPublic,
  extras?: { trustBundlePem?: string }
): TlsPublicRow | null {
  const metadata = assembleTlsMetadata(
    {
      status: row.status,
      notAfter: row.notAfter,
      fingerprintSha256: row.fingerprintSha256,
    },
    row.metadata
  )
  if (!metadata) return null
  const publicRow: TlsPublicRow = {
    id: row.id,
    name: row.name,
    source: row.source,
    organizationId: row.organizationId,
    metadata: plainAcmeNote(
      publicTlsMetadata(refreshTlsStatus(metadata), row.certificatePem !== null)
    ),
    options: parseTlsOptions(row.options),
    certificatePem: row.certificatePem,
    caGeneration: row.caGeneration ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (extras?.trustBundlePem !== undefined) {
    publicRow.trustBundlePem = extras.trustBundlePem
  }
  return publicRow
}

/** Private keys at rest must be `tpsecret` envelopes — never PEM plaintext. */
export function assertTpSecretPrivateKey(sealed: string): void {
  if (
    !isSealedEnvelope(sealed) ||
    !sealed.startsWith(`${ENVELOPE_MAGIC}.`) ||
    sealed.includes('BEGIN')
  ) {
    throw new TypeError('tls private key must be a tpsecret envelope')
  }
}

export type CaRotationConflictReason =
  | 'ca_rotation_in_progress'
  | 'no_pending_rotation'
  | 'ca_rotation_not_converged'
  | 'ca_leaves_outstanding'

export type CaRotationApiResult = {
  serverId: string
  status: string
  kind?: string
  managedId?: string
  commandId?: string
  error?: string
  /** Plain-language detail when the row is not finished yet. */
  reason?: string
}

export type CaRotationStatusBody = {
  rotationId: string
  fromGeneration: number
  toGeneration: number
  state: string
  results: CaRotationApiResult[]
  retiredCaStillRequired: boolean
  /** When the previous generation is retired by itself; null before fan-out finishes. */
  retireBy: string | null
}

export function rotationConflictResponse(reason: CaRotationConflictReason): {
  body: { error: CaRotationConflictReason }
  status: 409
} {
  return { body: { error: reason }, status: 409 }
}

export function toCaRotationApiResult(row: {
  serverId: string
  status: string
  kind?: string
  managedId?: string
  commandId?: string
  error?: string
  reason?: string
}): CaRotationApiResult {
  const result: CaRotationApiResult = {
    serverId: row.serverId,
    status: row.status,
  }
  if (row.kind) result.kind = row.kind
  if (row.managedId) result.managedId = row.managedId
  if (row.commandId) result.commandId = row.commandId
  if (row.error) result.error = row.error
  if (row.reason) result.reason = row.reason
  return result
}

export function rotationStatusResponse(params: {
  rotationId: string
  fromGeneration: number
  toGeneration: number
  state: string
  results: readonly CaRotationApiResult[]
  retireBy?: string | null
}): CaRotationStatusBody {
  return {
    rotationId: params.rotationId,
    fromGeneration: params.fromGeneration,
    toGeneration: params.toGeneration,
    state: params.state,
    results: [...params.results],
    retiredCaStillRequired: params.state !== 'completed',
    retireBy: params.state === 'awaiting_retire' ? (params.retireBy ?? null) : null,
  }
}

export function tlsFailurePayload(material: CreateTlsFailure): {
  body: { error: string; detail?: string }
  status: 400
} {
  if (material.detail === undefined) {
    return { body: { error: material.error }, status: material.status }
  }
  return {
    body: { error: material.error, detail: material.detail },
    status: material.status,
  }
}

export function isOrganizationCaExistsCode(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ORGANIZATION_CA_EXISTS'
  )
}

export type TlsInsertConflict =
  | { error: 'organization_ca_exists'; status: 409 }
  | { error: 'tls_fingerprint_conflict'; status: 409 }

export function classifyTlsInsertConflict(err: unknown): TlsInsertConflict | null {
  if (isOrganizationCaExistsCode(err) || isOrganizationCaUniqueViolation(err)) {
    return { error: 'organization_ca_exists', status: 409 }
  }
  if (isTlsFingerprintUniqueViolation(err)) {
    return { error: 'tls_fingerprint_conflict', status: 409 }
  }
  return null
}

/**
 * `GET /tls/ca/download` headers. The file is named after the organization id
 * (`turbopanel-org-ca-{organizationId}.pem`) so files from several
 * organizations do not overwrite each other; the UI saves under the same name.
 */
export function organizationCaDownloadHeaders(organizationId: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-pem-file',
    'Content-Disposition': `attachment; filename="turbopanel-org-ca-${organizationId}.pem"`,
  }
}

export function shouldRevokeTlsFromBody(body: Record<string, unknown>): boolean {
  return body.revoke === true
}

export type CreateTlsMaterial = {
  certificatePem: string | null
  privateKeyPemSealed: string | null
  metadata: TlsMetadata
  options: TlsOptions | null
}

export type CreateTlsFailure = {
  error: string
  detail?: string
  status: 400
}

export type CreateTlsResult = CreateTlsMaterial | CreateTlsFailure

export function parseSource(value: unknown): TlsSource | null {
  if (typeof value !== 'string') return null
  return (TLS_SOURCES as readonly string[]).includes(value) ? (value as TlsSource) : null
}

export function parseHostnames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const names = value
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 0)
  return names.length > 0 ? names : null
}

export function isCreateTlsFailure(result: CreateTlsResult): result is CreateTlsFailure {
  return 'status' in result
}

export function isTlsFingerprintUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOn(err, 'uniq_tls_organization_fingerprint_sha256')
}

export function createFailure(error: string, detail?: string): CreateTlsFailure {
  if (detail === undefined) {
    return { error, status: 400 }
  }
  return { error, detail, status: 400 }
}

export function materialFromLetsEncrypt(
  body: Record<string, unknown>,
  createdFor: 'hosting' | 'library' = 'library'
): CreateTlsResult {
  const hostnames = parseHostnames(body.hostnames)
  if (!hostnames) {
    return createFailure('Invalid request')
  }
  if (hostnames.some((n) => n.startsWith('*.'))) {
    return createFailure('wildcard_unsupported')
  }
  if (hostnames.some((n) => isLoopbackOrPrivateHostname(n))) {
    return createFailure('private_hostname_unsupported')
  }
  if (body.challengeType === 'dns-01') {
    return createFailure('dns_01_unsupported')
  }
  return {
    certificatePem: null,
    privateKeyPemSealed: null,
    metadata: {
      dnsNames: hostnames,
      hasWildcard: false,
      notBefore: new Date(0).toISOString(),
      notAfter: new Date(0).toISOString(),
      fingerprintSha256: '',
      subject: '',
      issuer: '',
      status: 'automatic',
      acme: {
        challengeType: 'http-01',
        managedBy: 'caddy',
        createdFor,
      },
    },
    options: {
      autoRenew: body.autoRenew !== false,
      requestedHostnames: hostnames,
    },
  }
}

export function withPreferOption(options: TlsOptions | null, prefer: unknown): TlsOptions | null {
  if (typeof prefer !== 'number' || !Number.isFinite(prefer)) {
    return options
  }
  if (options) {
    return { ...options, prefer }
  }
  return { prefer }
}

export type OptionsPatchResult = { ok: true; options: TlsOptions; changed: boolean } | { ok: false }

export function applyTlsOptionsPatch(
  currentOptions: TlsOptions,
  body: Record<string, unknown>
): OptionsPatchResult {
  const nextOptions: TlsOptions = { ...currentOptions }
  let changed = false

  if (body.prefer !== undefined) {
    if (body.prefer === null) {
      delete nextOptions.prefer
      changed = true
    } else if (typeof body.prefer === 'number' && Number.isFinite(body.prefer)) {
      nextOptions.prefer = body.prefer
      changed = true
    } else {
      return { ok: false }
    }
  }

  if (body.autoRenew !== undefined) {
    if (typeof body.autoRenew !== 'boolean') {
      return { ok: false }
    }
    nextOptions.autoRenew = body.autoRenew
    changed = true
  }

  return { ok: true, options: nextOptions, changed }
}

export async function materialFromUpload(
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig
): Promise<CreateTlsResult> {
  if (typeof body.certificatePem !== 'string' || typeof body.privateKeyPem !== 'string') {
    return createFailure('Invalid request')
  }
  try {
    // Normalize chain ordering (leaf first).
    const certificatePem = splitCertificateChain(body.certificatePem).join('')
    const parsed = await parseCertificatePem(certificatePem)
    // Every stored key is PKCS#8, whatever form was uploaded (SEC1 EC, PKCS#1 RSA, PKCS#8).
    const privateKeyPem = normalizePrivateKeyPem(body.privateKeyPem)
    const matches = await privateKeyMatchesCertificate(privateKeyPem, parsed)
    if (!matches) {
      return createFailure('certificate_key_mismatch')
    }
    const privateKeyPemSealed = await encryptSecret(secrets, privateKeyPem.trim())
    assertTpSecretPrivateKey(privateKeyPemSealed)
    return {
      certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(parsed, 'ready'),
      options: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid certificate'
    return createFailure('invalid_certificate', message)
  }
}

export async function materialFromSelfSigned(
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig
): Promise<CreateTlsResult> {
  const hostnames = parseHostnames(body.hostnames)
  if (!hostnames) {
    return createFailure('Invalid request')
  }
  try {
    const material = await mintSelfSignedCertificate(hostnames)
    const privateKeyPemSealed = await encryptSecret(secrets, material.privateKeyPem)
    assertTpSecretPrivateKey(privateKeyPemSealed)
    return {
      certificatePem: material.certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(material.parsed, 'ready'),
      options: { requestedHostnames: hostnames },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'self-signed mint failed'
    return createFailure('invalid_certificate', message)
  }
}

export async function materialFromOrganizationCa(
  secrets: DerivedSecretsConfig,
  opts: { organizationId: string }
): Promise<CreateTlsResult> {
  try {
    const material = await mintOrganizationCa({
      organizationId: opts.organizationId,
    })
    const privateKeyPemSealed = await encryptSecret(secrets, material.privateKeyPem)
    assertTpSecretPrivateKey(privateKeyPemSealed)
    return {
      certificatePem: material.certificatePem,
      privateKeyPemSealed,
      metadata: metadataFromParsed(material.parsed, 'ready'),
      options: null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'organization CA mint failed'
    return createFailure('invalid_certificate', message)
  }
}

export async function buildCreateTlsMaterial(
  source: TlsSource,
  body: Record<string, unknown>,
  secrets: DerivedSecretsConfig,
  organizationId: string
): Promise<CreateTlsResult> {
  switch (source) {
    case 'upload':
      return await materialFromUpload(body, secrets)
    case 'self_signed':
      return await materialFromSelfSigned(body, secrets)
    case 'lets_encrypt':
      return materialFromLetsEncrypt(body)
    case 'organization_ca':
      return await materialFromOrganizationCa(secrets, { organizationId })
    case 'provider_origin':
      // Issued through a tunnel's carrier (see features/tunnels), never created here.
      return createFailure('provider_origin_unsupported')
  }
}
