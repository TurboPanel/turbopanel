/**
 * The certificate alerts, all under the one `certificate.renewal_failed` event
 * code (the code is stored, so it stays; `context.kind` says which):
 *
 * - `issuance`: the first certificate for a name could not be obtained.
 * - `renewal`: a name that had a certificate could not renew it.
 * - `request_dropped`: a request that waited for DNS for 7 days was dropped.
 *
 * Plain words for what the host's probe said, and the emitters. The control
 * plane sends the first two from `handleAcmeIssuanceEvent` only on a new
 * failure (no earlier `lastError`), so a hostname that keeps failing alerts
 * once, and again only after a recovery. Let's Encrypt no longer sends expiry
 * emails, so these are the only warning a site owner gets.
 */
import type { Db } from '../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { emitNotification } from './emit.ts'

const MAX_DETAIL_CHARS = 200

const REASONS: ReadonlyArray<{ test: RegExp; text: string }> = [
  {
    test: /ENOTFOUND|NXDOMAIN|dns|name or service not known|failed to lookup|no record/i,
    text: 'The domain name does not point at this server yet.',
  },
  {
    test: /refused|ECONNREFUSED/i,
    text: 'Nothing answered on port 443, so the certificate could not be checked.',
  },
  {
    test: /timed? ?out|deadline|aborted/i,
    text: 'The server did not answer in time on port 443.',
  },
  {
    test: /UnknownIssuer|self[- ]signed|invalid peer certificate|certificate verify failed|alert/i,
    text: "The server is still showing a self-signed certificate; Let's Encrypt has not issued a real one yet.",
  },
  {
    test: /rate ?limit|too many/i,
    text: "Let's Encrypt is limiting new certificates for this domain for now.",
  },
  {
    test: /CAA/i,
    text: "A CAA record on the domain does not allow Let's Encrypt to issue.",
  },
]

/** The failure in plain words, from the host's raw probe text. Never empty. */
export function plainAcmeReason(raw: string | undefined): string {
  const text = (raw ?? '').trim()
  const known = REASONS.find((reason) => reason.test.test(text))
  if (known) return known.text
  return "Let's Encrypt could not issue or renew the certificate."
}

export type CertificateRenewalFailure = {
  organizationId: string
  hostname: string
  /** The host's raw error text; shown trimmed as the technical detail. */
  rawError?: string
  /** No certificate was ever obtained for this name: "couldn't get" rather than "renewal failed". */
  firstIssuance?: boolean
}

/** Which certificate alert this is (`context.kind`); older rows have none and read as `renewal`. */
export type CertificateAlertKind = 'issuance' | 'renewal' | 'request_dropped'

export type CertificateAlertDeps = {
  /** Test seam: the emitter. */
  emit?: typeof emitNotification
}

async function emitCertificateAlert(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  organizationId: string,
  context: Record<string, string>,
  deps: CertificateAlertDeps
): Promise<void> {
  const emit = deps.emit ?? emitNotification
  await emit(
    db,
    secrets,
    {
      event: 'certificate.renewal_failed',
      organizationId,
      context,
      targetType: 'hostname',
      targetId: null,
    },
    { allowPrivateTargets: true }
  )
}

/** One bell/channel alert for a certificate that failed to issue or renew. */
export async function emitCertificateRenewalFailed(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  failure: CertificateRenewalFailure,
  deps: CertificateAlertDeps = {}
): Promise<void> {
  const detail = failure.rawError?.trim().slice(0, MAX_DETAIL_CHARS)
  const kind: CertificateAlertKind = failure.firstIssuance === true ? 'issuance' : 'renewal'
  await emitCertificateAlert(
    db,
    secrets,
    failure.organizationId,
    {
      kind,
      hostname: failure.hostname,
      reason: plainAcmeReason(failure.rawError),
      ...(detail ? { detail } : {}),
    },
    deps
  )
}

export const REQUEST_DROPPED_REASON =
  "The domain's DNS did not point at the server within 7 days, so TurboPanel stopped waiting and the site keeps its self-signed certificate."

/** One alert for a waiting certificate request the sweep dropped after 7 days. */
export async function emitCertificateRequestDropped(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  dropped: { organizationId: string; hostname: string },
  deps: CertificateAlertDeps = {}
): Promise<void> {
  await emitCertificateAlert(
    db,
    secrets,
    dropped.organizationId,
    { kind: 'request_dropped', hostname: dropped.hostname, reason: REQUEST_DROPPED_REASON },
    deps
  )
}
