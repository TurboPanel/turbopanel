/** TLS certificate source discriminator — stored in `tls.source`. */
export type TlsSource = 'upload' | 'lets_encrypt' | 'self_signed' | 'organization_ca'

/** Lifecycle status — dedicated `tls.status` column (also in API metadata DTO). */
export type TlsStatus = 'ready' | 'pending' | 'expired' | 'failed' | 'revoked'

export type TlsAcmeMetadata = {
  orderUrl?: string
  challengeType?: 'http-01' | 'dns-01'
  lastError?: string
}

/**
 * Client-facing TLS metadata DTO. Persist `status` / `notAfter` /
 * `fingerprintSha256` on dedicated columns; residual jsonb keeps dnsNames /
 * subject / issuer / acme / notBefore / hasWildcard.
 */
export type TlsMetadata = {
  dnsNames: string[]
  hasWildcard: boolean
  notBefore: string
  notAfter: string
  fingerprintSha256: string
  subject: string
  issuer: string
  status: TlsStatus
  acme?: TlsAcmeMetadata
}

/** Operator knobs in `tls.options`. */
export type TlsOptions = {
  prefer?: number
  autoRenew?: boolean
  /** Requested names for LE / self-signed create before PEMs exist. */
  requestedHostnames?: string[]
}

export type ParsedCertificate = {
  dnsNames: string[]
  /** iPAddress SANs as dotted-quad IPv4 strings (when present). */
  ipAddresses: string[]
  hasWildcard: boolean
  notBefore: Date
  notAfter: Date
  fingerprintSha256: string
  subject: string
  issuer: string
  /** Leaf DER bytes (for fingerprint / diagnostics). */
  leafDer: Uint8Array
  /** SubjectPublicKeyInfo DER from the leaf. */
  spkiDer: Uint8Array
}

export type TlsCandidate = {
  id: string
  metadata: TlsMetadata
  options: TlsOptions | null
}

export type ResolveTlsResult =
  | { ok: true; tlsId: string | null; reason: 'pin' | 'internal' }
  | { ok: false; error: 'pin_not_found' | 'pin_mismatch' | 'pin_not_ready' }

export const TLS_SOURCES: readonly TlsSource[] = [
  'upload',
  'lets_encrypt',
  'self_signed',
  'organization_ca',
] as const
