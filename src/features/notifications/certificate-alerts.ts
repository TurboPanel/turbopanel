/**
 * The "certificate renewal failed" alert: plain words for what the host's
 * probe said, and the one emitter. The control plane calls it from
 * `handleAcmeIssuanceEvent` only on a new failure (no earlier `lastError`), so
 * a hostname that keeps failing alerts once, and again only after a recovery.
 */
import type { Db } from '../../db/connection.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { emitNotification } from './emit.ts'
import { isNotificationEventLive } from './events.ts'

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
    text: "The server is still showing a test certificate; Let's Encrypt has not issued a real one yet.",
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
}

export type CertificateAlertDeps = {
  /** Test seams: whether the event is accepted by the database, and the emitter. */
  live?: boolean
  emit?: typeof emitNotification
}

/**
 * One bell/channel alert for a certificate that failed to issue or renew.
 * Stays quiet until the database accepts the event (its migration is applied
 * and the event is in the pinned vocabulary), so an unmigrated database never
 * sees a failing insert per failure.
 */
export async function emitCertificateRenewalFailed(
  db: Db,
  secrets: DerivedSecretsConfig | undefined,
  failure: CertificateRenewalFailure,
  deps: CertificateAlertDeps = {}
): Promise<void> {
  const live = deps.live ?? isNotificationEventLive('certificate.renewal_failed')
  if (!live) return
  const emit = deps.emit ?? emitNotification
  const detail = failure.rawError?.trim().slice(0, MAX_DETAIL_CHARS)
  await emit(
    db,
    secrets,
    {
      event: 'certificate.renewal_failed',
      organizationId: failure.organizationId,
      context: {
        hostname: failure.hostname,
        reason: plainAcmeReason(failure.rawError),
        ...(detail ? { detail } : {}),
      },
      targetType: 'hostname',
      targetId: null,
    },
    { allowPrivateTargets: true }
  )
}
