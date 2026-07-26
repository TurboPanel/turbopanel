import type { ParsedCertificate, TlsMetadata, TlsStatus } from './types.ts'

/** Residual `tls.metadata` jsonb — promoted fields live in dedicated columns. */
export type TlsResidualMetadata = Omit<
  TlsMetadata,
  'status' | 'notAfter' | 'fingerprintSha256'
>

export type TlsStatusColumns = {
  status: string | null | undefined
  notAfter: string | null | undefined
  fingerprintSha256: string | null | undefined
}

const TLS_STATUSES = new Set<TlsStatus>([
  'ready',
  'pending',
  'expired',
  'failed',
  'revoked',
])

function isTlsStatus(value: unknown): value is TlsStatus {
  return typeof value === 'string' && TLS_STATUSES.has(value as TlsStatus)
}

export function metadataFromParsed(
  parsed: ParsedCertificate,
  status: TlsStatus = 'ready',
): TlsMetadata {
  return {
    dnsNames: parsed.dnsNames,
    hasWildcard: parsed.hasWildcard,
    notBefore: parsed.notBefore.toISOString(),
    notAfter: parsed.notAfter.toISOString(),
    fingerprintSha256: parsed.fingerprintSha256,
    subject: parsed.subject,
    issuer: parsed.issuer,
    status,
  }
}

/** Split a full metadata DTO into column values + residual jsonb payload. */
export function splitTlsMetadata(metadata: TlsMetadata): {
  columns: {
    status: TlsStatus
    notAfter: string
    fingerprintSha256: string | null
  }
  residual: TlsResidualMetadata
} {
  const fingerprint = metadata.fingerprintSha256.trim()
  return {
    columns: {
      status: metadata.status,
      notAfter: metadata.notAfter,
      fingerprintSha256: fingerprint.length > 0 ? fingerprint : null,
    },
    residual: {
      dnsNames: metadata.dnsNames,
      hasWildcard: metadata.hasWildcard,
      notBefore: metadata.notBefore,
      subject: metadata.subject,
      issuer: metadata.issuer,
      ...(metadata.acme ? { acme: metadata.acme } : {}),
    },
  }
}

/** Assemble the client-facing metadata DTO from columns + residual jsonb. */
export function assembleTlsMetadata(
  columns: TlsStatusColumns,
  residual: unknown,
): TlsMetadata | null {
  if (typeof residual !== 'object' || residual === null || Array.isArray(residual)) {
    return null
  }
  const record = residual as Record<string, unknown>
  if (!Array.isArray(record.dnsNames) || !record.dnsNames.every((n) => typeof n === 'string')) {
    return null
  }
  if (typeof record.hasWildcard !== 'boolean') return null
  if (typeof record.notBefore !== 'string') return null
  if (typeof record.subject !== 'string' || typeof record.issuer !== 'string') {
    return null
  }

  // Promoted fields are required from their dedicated columns.
  const notAfter = typeof columns.notAfter === 'string' && columns.notAfter.length > 0
    ? columns.notAfter
    : null

  // Pending / non-materialized certs store NULL in the column (partial unique
  // index) — expose '' on the client DTO.
  const fingerprintSha256 = typeof columns.fingerprintSha256 === 'string'
    ? columns.fingerprintSha256
    : ''

  const status = isTlsStatus(columns.status) ? columns.status : null

  if (notAfter === null || status === null) {
    return null
  }

  const assembled: TlsMetadata = {
    dnsNames: record.dnsNames as string[],
    hasWildcard: record.hasWildcard,
    notBefore: record.notBefore,
    notAfter,
    fingerprintSha256,
    subject: record.subject,
    issuer: record.issuer,
    status,
  }
  if (record.acme !== undefined) {
    assembled.acme = record.acme as TlsMetadata['acme']
  }
  return assembled
}

/** Mark ready certs past notAfter as expired for API responses. */
export function refreshTlsStatus(
  metadata: TlsMetadata,
  now: Date = new Date(),
): TlsMetadata {
  if (metadata.status !== 'ready') return metadata
  const notAfter = Date.parse(metadata.notAfter)
  if (!Number.isNaN(notAfter) && now.getTime() > notAfter) {
    return { ...metadata, status: 'expired' }
  }
  return metadata
}
