/**
 * What the panel remembers about a DNS-validated certificate between steps:
 * which provider account and zones it uses, and, while an order is open, the
 * authority's addresses, the challenge records it published and the sealed
 * account key. It lives in the private part of `tls.metadata` (`dnsCert`), a
 * key the public row never copies, so nothing here reaches a client.
 */

export type ZoneRef = { id: string; name: string }

export type ChallengeState = {
  authzUrl: string
  challengeUrl: string
  token: string
  /** The record name published, `_acme-challenge.example.com`. */
  name: string
  value: string
  zoneId: string
  /** Set once the TXT record exists at the provider. */
  recordId: string | null
}

export type OrderState = {
  /** The organization's account key, sealed, kept so an open order can finish on its own. */
  accountKey: string
  accountUrl: string
  orderUrl: string
  finalizeUrl: string
  challenges: ChallengeState[]
  startedAt: string
  /** When the records were all published; the challenge is answered a little later. */
  presentedAt: string | null
  /** The challenges were answered. */
  answeredAt: string | null
  /** The request for the certificate was sent. */
  finalizedAt: string | null
  /** Renewals only: the sealed new key, swapped in with the new certificate. */
  pendingKey: string | null
  renewal: boolean
}

/** A TXT record this panel made and has not yet removed; removal is always by this id. */
export type PublishedRecord = { zoneId: string; recordId: string; name: string; createdAt: string }

export type DnsCertState = {
  carrierId: string
  zones: ZoneRef[]
  staging: boolean
  /** Failed orders since the last good certificate. */
  attempts: number
  /** Do not start or continue before this time (rate limit or back-off). */
  nextAttemptAt: string | null
  /** Another worker holds the row until this time. */
  claimUntil: string | null
  order: OrderState | null
  /** Records made and not yet removed, written the moment each is made so a crash cannot lose one. */
  records: PublishedRecord[]
  /** When to start renewing: the authority's suggested window, or a third of the lifetime before the end. */
  renewAt: string | null
  /** When the authority was last asked about renewal timing. */
  ariCheckedAt: string | null
}

export const DNS_CERT_KEY = 'dnsCert'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readChallenge(value: unknown): ChallengeState | null {
  const r = record(value)
  const authzUrl = text(r?.authzUrl)
  const challengeUrl = text(r?.challengeUrl)
  const token = text(r?.token)
  const name = text(r?.name)
  const challengeValue = text(r?.value)
  const zoneId = text(r?.zoneId)
  if (!authzUrl || !challengeUrl || !token || !name || !challengeValue || !zoneId) return null
  return {
    authzUrl,
    challengeUrl,
    token,
    name,
    value: challengeValue,
    zoneId,
    recordId: text(r?.recordId),
  }
}

function readOrder(value: unknown): OrderState | null {
  const r = record(value)
  const accountKey = text(r?.accountKey)
  const accountUrl = text(r?.accountUrl)
  const orderUrl = text(r?.orderUrl)
  const finalizeUrl = text(r?.finalizeUrl)
  const startedAt = text(r?.startedAt)
  if (!accountKey || !accountUrl || !orderUrl || !finalizeUrl || !startedAt) return null
  const challenges = Array.isArray(r?.challenges)
    ? r.challenges.map(readChallenge).filter((c): c is ChallengeState => c !== null)
    : []
  return {
    accountKey,
    accountUrl,
    orderUrl,
    finalizeUrl,
    challenges,
    startedAt,
    presentedAt: text(r?.presentedAt),
    answeredAt: text(r?.answeredAt),
    finalizedAt: text(r?.finalizedAt),
    pendingKey: text(r?.pendingKey),
    renewal: r?.renewal === true,
  }
}

function readRecords(value: unknown): PublishedRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .map((r) => ({
      zoneId: text(record(r)?.zoneId),
      recordId: text(record(r)?.recordId),
      name: text(record(r)?.name),
      createdAt: text(record(r)?.createdAt),
    }))
    .filter(
      (r): r is PublishedRecord =>
        r.zoneId !== null && r.recordId !== null && r.name !== null && r.createdAt !== null
    )
}

function readZones(value: unknown): ZoneRef[] {
  if (!Array.isArray(value)) return []
  return value
    .map((z) => ({ id: text(record(z)?.id), name: text(record(z)?.name) }))
    .filter((z): z is ZoneRef => z.id !== null && z.name !== null)
}

/** The private state of a DNS-validated row, or null when the row has none. */
export function readDnsCertState(metadata: unknown): DnsCertState | null {
  const r = record(record(metadata)?.[DNS_CERT_KEY])
  const carrierId = text(r?.carrierId)
  if (!r || !carrierId) return null
  const attempts = typeof r.attempts === 'number' && r.attempts >= 0 ? r.attempts : 0
  return {
    carrierId,
    zones: readZones(r.zones),
    staging: r.staging === true,
    attempts,
    nextAttemptAt: text(r.nextAttemptAt),
    claimUntil: text(r.claimUntil),
    order: readOrder(r.order),
    records: readRecords(r.records),
    renewAt: text(r.renewAt),
    ariCheckedAt: text(r.ariCheckedAt),
  }
}

/** The metadata object with the private state replaced; nothing else is touched. */
export function withDnsCertState(metadata: unknown, state: DnsCertState): Record<string, unknown> {
  return { ...record(metadata), [DNS_CERT_KEY]: state }
}

/** Does the row belong to the DNS-validated flow (public marker, not the private block)? */
export function isPanelManagedAcme(metadata: unknown): boolean {
  const acme = record(record(metadata)?.acme)
  return acme?.managedBy === 'panel' && acme.challengeType === 'dns-01'
}
