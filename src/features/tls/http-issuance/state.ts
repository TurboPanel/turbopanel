/**
 * What the panel remembers about a certificate ordered by a server's daemon
 * over the HTTP proof: which server was asked, which request is open, and how
 * the other servers did at passing the proof path along. It lives in the
 * private part of `tls.metadata` (`httpCert`), a key the public row never
 * copies, so nothing here reaches a client. The public marker (`managedBy`,
 * `challengeType`) sits in `metadata.acme` like the DNS kind.
 *
 * Nothing here talks to the network or the database: it is plain reading,
 * writing and one yes-or-no rule, safe to import from Workers-reachable code.
 */

/** Public marker values written to `metadata.acme` for a certificate ordered this way. */
export const HTTP_ISSUANCE_MANAGED_BY = 'server' as const
export const HTTP_ISSUANCE_CHALLENGE_TYPE = 'http-01' as const

export const HTTP_CERT_KEY = 'httpCert'

export type ForwardOutcome = 'pending' | 'ready' | 'failed' | 'skipped'

/** How one other serving server did at passing the proof path to the issuing server. */
export type ForwardResult = {
  serverId: string
  outcome: ForwardOutcome
  /** A plain reason for `failed` or `skipped`. */
  reason: string | null
  at: string | null
}

export type HttpIssuanceState = {
  /** The server asked to place the order. */
  issuingServerId: string
  /** The open request; a pair is accepted only for this id. */
  requestId: string
  startedAt: string
  /** The request stays open until this time (ISO 8601). */
  startByAt: string
  /** Set when the request finished or was given up; a closed request takes no pair. */
  endedAt: string | null
  forwards: ForwardResult[]
  /** When orders were started, newest last; the attempt cap counts these. */
  attemptTimes: string[]
  /** Do not start another attempt before this time (back-off). */
  nextAttemptAt: string | null
}

const FORWARD_OUTCOMES: ReadonlySet<string> = new Set(['pending', 'ready', 'failed', 'skipped'])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readForwards(value: unknown): ForwardResult[] {
  if (!Array.isArray(value)) return []
  const out: ForwardResult[] = []
  for (const item of value) {
    const r = record(item)
    const serverId = text(r?.serverId)
    if (!r || !serverId || typeof r.outcome !== 'string' || !FORWARD_OUTCOMES.has(r.outcome)) {
      continue
    }
    out.push({
      serverId,
      outcome: r.outcome as ForwardOutcome,
      reason: text(r.reason),
      at: text(r.at),
    })
  }
  return out
}

/** The private state of a row ordered over the HTTP proof, or null when the row has none. */
export function readHttpIssuanceState(metadata: unknown): HttpIssuanceState | null {
  const r = record(record(metadata)?.[HTTP_CERT_KEY])
  const issuingServerId = text(r?.issuingServerId)
  const requestId = text(r?.requestId)
  const startedAt = text(r?.startedAt)
  const startByAt = text(r?.startByAt)
  if (!r || !issuingServerId || !requestId || !startedAt || !startByAt) return null
  return {
    issuingServerId,
    requestId,
    startedAt,
    startByAt,
    endedAt: text(r.endedAt),
    forwards: readForwards(r.forwards),
    attemptTimes: Array.isArray(r.attemptTimes)
      ? r.attemptTimes.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [],
    nextAttemptAt: text(r.nextAttemptAt),
  }
}

/** The metadata object with the private state replaced; nothing else is touched. */
export function withHttpIssuanceState(
  metadata: unknown,
  state: HttpIssuanceState
): Record<string, unknown> {
  return { ...record(metadata), [HTTP_CERT_KEY]: state }
}

export type CaptureRefusalReason = 'unknown_request' | 'closed' | 'expired' | 'wrong_server'

export type CaptureDecision = { ok: true } | { ok: false; reason: CaptureRefusalReason }

/**
 * Whether a pair reported for `requestId` by `serverId` may be stored: the row
 * must hold that open request, the reporting server must be the one asked, and
 * the request must not have been closed or run past its time. `serverId` comes
 * from the daemon's token, never from the request body.
 */
export function canAcceptCapture(
  state: HttpIssuanceState | null,
  call: { serverId: string; requestId: string; now: Date }
): CaptureDecision {
  if (state?.requestId !== call.requestId) return { ok: false, reason: 'unknown_request' }
  if (state.endedAt !== null) return { ok: false, reason: 'closed' }
  const until = Date.parse(state.startByAt)
  if (Number.isNaN(until) || call.now.getTime() > until) return { ok: false, reason: 'expired' }
  if (state.issuingServerId !== call.serverId) return { ok: false, reason: 'wrong_server' }
  return { ok: true }
}
