/** TLS certificate source discriminator — stored in `tls.source`. */
export type TlsSource = 'upload' | 'lets_encrypt' | 'self_signed'

/** Lifecycle status in `tls.metadata.status`. */
export type TlsStatus = 'ready' | 'pending' | 'expired' | 'failed' | 'revoked'

export type TlsAcmeMetadata = {
  orderUrl?: string
  challengeType?: 'http-01' | 'dns-01'
  lastError?: string
}

/** Canonical `tls.metadata` shape. */
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
] as const
