/**
 * What happens next to a server-placed order, decided from the stored state and
 * the clock alone, and the public marker a state turns into. Pure: the
 * orchestrator does the reading, the writing and the sending.
 */
import type { TlsAcmeMetadata } from '../../../lib/tls/types.ts'
import { backoffMs, isRateLimitReason, RATE_LIMIT_WAIT_MS } from './attempts.ts'
import { plainCertificateFailure } from '../../hostings/acme-failure-text.ts'
import { redactUrlSecrets } from '../../upgrades/redact-url-secrets.ts'
import {
  closedAsIssued,
  HTTP_ISSUANCE_CHALLENGE_TYPE,
  HTTP_ISSUANCE_MANAGED_BY,
  type HttpIssuanceState,
} from './state.ts'
import { serverStatusLines } from './status-text.ts'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** How long the helpers get to answer before the order starts without them. */
export const READY_WAIT_MS = 2 * MINUTE
/** An issuing server that has not said `started` this long after the request is silent. */
export const START_SILENCE_MS = 3 * MINUTE
/** After `started`, how long the issuing server may stay quiet before the order is given up. */
export const ORDER_SILENCE_MS = 10 * MINUTE
/** After `issued`, how long the pair may take to arrive. */
export const PAIR_WAIT_MS = 5 * MINUTE
/** The whole request, including forwards, lives this long. */
export const REQUEST_LIFETIME_MS = 30 * MINUTE

export type OpenAction =
  | { kind: 'wait' }
  /** Send `acme-issue-request`; `skip` are helpers that never answered. */
  | { kind: 'order'; skip: string[] }
  | { kind: 'fail'; reason: string; blameIssuer: boolean }

const since = (iso: string | null, now: Date): number =>
  iso === null || Number.isNaN(Date.parse(iso)) ? 0 : now.getTime() - Date.parse(iso)

function forwardingAction(state: HttpIssuanceState, now: Date): OpenAction {
  // A helper that answered but could not pass the proof path on would let the
  // authority land on a server that cannot answer, which spends a failed check.
  const failed = state.forwards.find((f) => f.outcome === 'failed')
  if (failed) {
    const label = state.roster.find((r) => r.serverId === failed.serverId)?.label ?? 'A server'
    const why = failed.reason ? `: ${failed.reason}` : '.'
    return {
      kind: 'fail',
      reason: `${label} could not pass the check along${why}`,
      blameIssuer: false,
    }
  }
  const pending = state.forwards.filter((f) => f.outcome === 'pending').map((f) => f.serverId)
  if (pending.length === 0) return { kind: 'order', skip: [] }
  return since(state.startedAt, now) >= READY_WAIT_MS
    ? { kind: 'order', skip: pending }
    : { kind: 'wait' }
}

function orderingAction(state: HttpIssuanceState, now: Date): OpenAction {
  if (state.issuedEventAt !== null) {
    return since(state.issuedEventAt, now) >= PAIR_WAIT_MS
      ? {
          kind: 'fail',
          reason: 'The server finished the order but did not send the certificate.',
          blameIssuer: true,
        }
      : { kind: 'wait' }
  }
  const quiet = state.lastEventAt === null ? START_SILENCE_MS : ORDER_SILENCE_MS
  const base = state.lastEventAt ?? state.orderSentAt
  if (since(base, now) >= quiet) {
    return { kind: 'fail', reason: 'The server did not answer the order.', blameIssuer: true }
  }
  return { kind: 'wait' }
}

/** The next step for a request that is still open. */
export function decideOpen(state: HttpIssuanceState, now: Date): OpenAction {
  if (state.endedAt !== null) return { kind: 'wait' }
  if (now.getTime() >= Date.parse(state.startByAt)) {
    return { kind: 'fail', reason: 'The order did not finish in time.', blameIssuer: true }
  }
  return state.phase === 'forwarding' ? forwardingAction(state, now) : orderingAction(state, now)
}

/** The request given up: closed, a plain reason kept, and the wait before the next try set. */
export function failedState(
  state: HttpIssuanceState,
  now: Date,
  reason: string,
  blameIssuer: boolean
): HttpIssuanceState {
  const failures = state.consecutiveFailures + 1
  const wait = Math.max(backoffMs(failures), isRateLimitReason(reason) ? RATE_LIMIT_WAIT_MS : 0)
  return {
    ...state,
    phase: 'failed',
    endedAt: now.toISOString(),
    lastError: reason,
    consecutiveFailures: failures,
    nextAttemptAt: new Date(now.getTime() + wait).toISOString(),
    avoidServerId: blameIssuer ? state.issuingServerId : state.avoidServerId,
  }
}

function stageOf(state: HttpIssuanceState): string {
  if (state.phase === 'failed') return 'backoff'
  return state.phase
}

/**
 * The public marker for the row: what a person may see (stage, a plain error,
 * the next try, one line per server). Nothing private (request id, server ids
 * of helpers' replies) is copied beyond the status lines' server ids.
 */
export function publicMarker(
  previous: TlsAcmeMetadata | undefined,
  state: HttpIssuanceState
): TlsAcmeMetadata {
  const next: TlsAcmeMetadata = {
    ...previous,
    managedBy: HTTP_ISSUANCE_MANAGED_BY,
    challengeType: HTTP_ISSUANCE_CHALLENGE_TYPE,
    stage: stageOf(state),
    attempts: state.consecutiveFailures,
    serverStatus: serverStatusLines(state),
  }
  delete next.warning
  // Only a Test Certificate carries this flag, and it cannot be pinned to a site.
  delete next.staging
  if (state.phase === 'failed' && state.lastError) next.lastError = state.lastError
  else delete next.lastError
  if (state.nextAttemptAt !== null && state.phase === 'failed') {
    next.nextAttemptAt = state.nextAttemptAt
  } else delete next.nextAttemptAt
  return next
}

/** The marker while no server can take the order, with the plain reason. */
export function waitingMarker(
  previous: TlsAcmeMetadata | undefined,
  text: string
): TlsAcmeMetadata {
  const next: TlsAcmeMetadata = {
    ...previous,
    managedBy: HTTP_ISSUANCE_MANAGED_BY,
    challengeType: HTTP_ISSUANCE_CHALLENGE_TYPE,
    stage: 'waiting',
    warning: text,
  }
  return next
}

/** What an `acme-issue-event` says, reduced to what the state needs. */
export type IssueEventFacts = {
  stage: 'started' | 'issued' | 'failed'
  reason?: string
  notAfterIso?: string
}

/** The state after an event; the same object when the event changes nothing. */
export function nextStateForEvent(
  state: HttpIssuanceState,
  input: IssueEventFacts,
  now: Date
): HttpIssuanceState {
  if (state.endedAt !== null) return state
  const at = now.toISOString()
  if (input.stage === 'started') return { ...state, phase: 'ordering', lastEventAt: at }
  if (input.stage === 'failed') {
    const reason = plainCertificateFailure(redactUrlSecrets(input.reason ?? 'The order failed.'))
    return failedState({ ...state, lastEventAt: at }, now, reason, true)
  }
  const issued: HttpIssuanceState = {
    ...state,
    phase: 'ordering',
    lastEventAt: at,
    issuedEventAt: at,
    notAfterIso: input.notAfterIso ?? state.notAfterIso,
  }
  return issued.capturedAt === null ? issued : closedAsIssued(issued, at)
}

/** Helper answers folded into the state; an answer from a server that was not asked is ignored. */
export type ForwardReport = {
  serverId: string
  outcome: 'ready' | 'failed' | 'skipped'
  reason?: string
}

export function applyForwardReports(
  state: HttpIssuanceState,
  reports: ForwardReport[],
  now: Date
): HttpIssuanceState {
  if (state.endedAt !== null) return state
  const forwards = state.forwards.map((f) => {
    const report = reports.find((r) => r.serverId === f.serverId)
    if (!report || f.outcome !== 'pending') return f
    return {
      ...f,
      outcome: report.outcome,
      reason: report.outcome === 'ready' ? null : (report.reason ?? 'Unknown reason.'),
      at: now.toISOString(),
    }
  })
  return { ...state, forwards }
}

/**
 * Whether the pair this flow ordered should be ordered again: the stored
 * renewal time (about two thirds into its life) has come. A pair the flow did
 * not order is never renewed here, and a flow pair with no readable renewal
 * time is renewed rather than left to expire.
 */
export function renewalDue(state: HttpIssuanceState | null, now: Date): boolean {
  if (state?.centralPair !== true) return false
  const at = state.renewAt === null ? Number.NaN : Date.parse(state.renewAt)
  return Number.isNaN(at) || now.getTime() >= at
}

/** Why Replace Key is refused now, or null when it may start. */
export type ReplaceKeyRefusal = 'too_soon' | 'weekly_limit' | 'no_certificate' | 'in_progress'

/** The authority's limit for one exact name set. */
export const ISSUES_PER_WEEK = 5

export type ReplaceKeyVerdict =
  | { ok: true; leftThisWeek: number }
  | { ok: false; reason: ReplaceKeyRefusal; leftThisWeek: number; notBefore?: Date }

/**
 * Replace Key starts a fresh order for the same names with a new key. It is a
 * new issue for the authority, so it counts against the 5 a week for one exact
 * name set, and it is offered at most once a day. `hasPair` is whether the row
 * holds a certificate to replace.
 */
export function mayReplaceKey(
  state: HttpIssuanceState | null,
  hasPair: boolean,
  now: Date
): ReplaceKeyVerdict {
  const t = now.getTime()
  const times = (state?.issueTimes ?? [])
    .map((x) => Date.parse(x))
    .filter((x) => !Number.isNaN(x))
    .sort((a, b) => a - b)
  const week = times.filter((x) => x > t - 7 * DAY)
  const left = Math.max(0, ISSUES_PER_WEEK - week.length)
  if (!hasPair) return { ok: false, reason: 'no_certificate', leftThisWeek: left }
  if (state && state.endedAt === null)
    return { ok: false, reason: 'in_progress', leftThisWeek: left }
  const last = times.at(-1)
  if (last !== undefined && last > t - DAY) {
    return { ok: false, reason: 'too_soon', leftThisWeek: left, notBefore: new Date(last + DAY) }
  }
  if (left === 0) {
    return {
      ok: false,
      reason: 'weekly_limit',
      leftThisWeek: 0,
      notBefore: new Date(week[0] + 7 * DAY),
    }
  }
  return { ok: true, leftThisWeek: left }
}
