/** TLS certificate source discriminator — stored in `tls.source`. */
export type TlsSource =
  'upload' | 'lets_encrypt' | 'self_signed' | 'organization_ca' | 'provider_origin'

/** Lifecycle status — dedicated `tls.status` column (also in API metadata DTO). */
export type TlsStatus = 'ready' | 'pending' | 'expired' | 'failed' | 'revoked' | 'automatic'

export type TlsAcmeMetadata = {
  orderUrl?: string
  challengeType?: 'http-01' | 'dns-01'
  /** Latest daemon-observed issuance failure; cleared on the next good probe. */
  lastError?: string
  /** When a certificate was last seen newly in place (ISO 8601): first good probe, a recovery, or a changed `notAfter`. */
  lastIssuedAt?: string
  /** Expiry of the certificate Caddy is serving, as the daemon's probe read it (ISO 8601). */
  notAfter?: string
  /**
   * `caddy` on `lets_encrypt` rows Caddy issues and renews on the host; `panel`
   * on a library certificate this panel ordered itself through a DNS challenge.
   */
  managedBy?: 'caddy' | 'panel'
  /** DNS-challenge certificates: where the order stands (queued, presented, validating, finalizing, issued, backoff, failed). */
  stage?: string
  /** DNS-challenge certificates: the authority's test directory, whose certificates no browser trusts. */
  staging?: boolean
  /** DNS-challenge certificates: failed orders since the last good certificate. */
  attempts?: number
  /** DNS-challenge certificates: no new attempt before this time (ISO 8601). */
  nextAttemptAt?: string
  /** DNS-challenge certificates: when renewal starts (ISO 8601). */
  renewAt?: string
  /** DNS-challenge certificates: something that will stop the next renewal, in plain words. */
  warning?: string
  /** DNS names the stored certificate covers (set when the pair is stored). */
  storedNames?: string[]
  /** The server whose Caddy issued the stored certificate (its daemon sent the pair). */
  issuedByServerId?: string
  /**
   * Who asked for the entry: `hosting` when a site's "Use Let's Encrypt" made
   * it (removed once no site uses it), `library` when a person added it.
   */
  createdFor?: 'hosting' | 'library'
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
  /** Discriminator from `tls.source`; required to pin an `automatic` LE row. */
  source?: TlsSource
}

/** Why a pinned library certificate cannot serve a hosting. */
export type TlsPinError = 'pin_not_found' | 'pin_mismatch' | 'pin_not_ready' | 'pin_staging'

export type ResolveTlsResult =
  { ok: true; tlsId: string | null; reason: 'pin' | 'internal' } | { ok: false; error: TlsPinError }

export const TLS_SOURCES: readonly TlsSource[] = [
  'upload',
  'lets_encrypt',
  'self_signed',
  'organization_ca',
  'provider_origin',
] as const
