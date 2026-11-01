/**
 * DNS-01 progress for one control plane hostname, kept in
 * `origin.acme_state`. It never holds a private key or a token: the
 * certificate key lives only inside the step that finalizes the order.
 */

export const DNS01_STAGES = [
  'idle',
  'preflight',
  'ordering',
  'publishing',
  'waiting-dns',
  'validating',
  'finalizing',
  'issued',
  'failed',
  'backoff',
] as const
export type Dns01Stage = (typeof DNS01_STAGES)[number]

export const DNS01_CAUSES = [
  'zone-not-on-provider',
  'scope-missing',
  'txt-not-visible',
  'caa-forbids',
  'duplicate-limit',
  'failed-authz-limit',
  'provider-error',
  'provider-rate-limited',
  'acme-error',
  'account-error',
] as const
export type Dns01Cause = (typeof DNS01_CAUSES)[number]

export type Dns01Failure = { cause: Dns01Cause; detail: string }

/** One open order: the authority's addresses and the published challenge record. */
export type Dns01Order = {
  url: string
  finalizeUrl: string
  authzUrl: string
  challengeUrl: string
  txtName: string
  txtValue: string
  record: { zoneId: string; recordId: string } | null
  nameservers: string[]
  startedAt: string
  /** When the challenge was answered; null while waiting for DNS. */
  answeredAt: string | null
}

export type Dns01State = {
  v: 1
  stage: Dns01Stage
  order: Dns01Order | null
  attempts: number
  /** Start times of recent orders, to stay under the authority's hourly failure limit. */
  attemptTimes: string[]
  nextAttemptAt: string | null
  /** Set by an authority limit: no order (manual or not) starts before it. */
  stopUntil: string | null
  lastError: (Dns01Failure & { at: string }) | null
  renewAt: string | null
  /** Renewal-information id of the current certificate (RFC 9773). */
  replaces: string | null
  issuedAt: string | null
  /** The pair before the current one, kept one renewal for rollback. */
  previousCertId: string | null
  /** The cause already alerted for the current failure run; cleared on success. */
  alertedCause: Dns01Cause | null
  /** Expiry countdown thresholds (days) already alerted for the current certificate. */
  expiryAlerted: number[]
  /** True once the expired pair has been swapped for the Platform CA leaf on the daemon. */
  expiryApplied: boolean
}

export const IDLE_STATE: Dns01State = {
  v: 1,
  stage: 'idle',
  order: null,
  attempts: 0,
  attemptTimes: [],
  nextAttemptAt: null,
  stopUntil: null,
  lastError: null,
  renewAt: null,
  replaces: null,
  issuedAt: null,
  previousCertId: null,
  alertedCause: null,
  expiryAlerted: [],
  expiryApplied: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function readOrder(value: unknown): Dns01Order | null {
  if (!isRecord(value)) return null
  const url = text(value.url)
  const authzUrl = text(value.authzUrl)
  const challengeUrl = text(value.challengeUrl)
  if (!url || !authzUrl || !challengeUrl) return null
  const record = isRecord(value.record) ? value.record : null
  return {
    url,
    finalizeUrl: text(value.finalizeUrl) ?? '',
    authzUrl,
    challengeUrl,
    txtName: text(value.txtName) ?? '',
    txtValue: text(value.txtValue) ?? '',
    record:
      record && text(record.zoneId) && text(record.recordId)
        ? { zoneId: record.zoneId as string, recordId: record.recordId as string }
        : null,
    nameservers: strings(value.nameservers),
    startedAt: text(value.startedAt) ?? '',
    answeredAt: text(value.answeredAt),
  }
}

function readError(value: unknown): Dns01State['lastError'] {
  if (!isRecord(value)) return null
  const cause = (DNS01_CAUSES as readonly unknown[]).includes(value.cause)
    ? (value.cause as Dns01Cause)
    : 'acme-error'
  return { cause, detail: text(value.detail) ?? '', at: text(value.at) ?? '' }
}

/** Tolerant reader: anything unknown starts from idle. */
export function readDns01State(raw: unknown): Dns01State {
  if (!isRecord(raw) || raw.v !== 1) return { ...IDLE_STATE }
  const stage = (DNS01_STAGES as readonly unknown[]).includes(raw.stage)
    ? (raw.stage as Dns01Stage)
    : 'idle'
  const alerted = raw.alertedCause
  return {
    v: 1,
    stage,
    order: readOrder(raw.order),
    attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
    attemptTimes: strings(raw.attemptTimes),
    nextAttemptAt: text(raw.nextAttemptAt),
    stopUntil: text(raw.stopUntil),
    lastError: readError(raw.lastError),
    renewAt: text(raw.renewAt),
    replaces: text(raw.replaces),
    issuedAt: text(raw.issuedAt),
    previousCertId: text(raw.previousCertId),
    alertedCause: (DNS01_CAUSES as readonly unknown[]).includes(alerted)
      ? (alerted as Dns01Cause)
      : null,
    expiryAlerted: Array.isArray(raw.expiryAlerted)
      ? raw.expiryAlerted.filter((day): day is number => typeof day === 'number')
      : [],
    expiryApplied: raw.expiryApplied === true,
  }
}

export function withStage(
  state: Dns01State,
  stage: Dns01Stage,
  patch: Partial<Dns01State> = {}
): Dns01State {
  return { ...state, ...patch, stage }
}

/** Stages in which an order is open and the tick should move it on. */
export function inProgress(stage: Dns01Stage): boolean {
  return stage === 'waiting-dns' || stage === 'validating'
}
