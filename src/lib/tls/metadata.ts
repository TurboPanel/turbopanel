import type { ParsedCertificate, TlsMetadata, TlsStatus } from './types.ts'

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
