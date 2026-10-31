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

/** Where an open or finished request stands. */
export type HttpIssuancePhase = 'forwarding' | 'ordering' | 'issued' | 'failed'

const PHASES: ReadonlySet<string> = new Set(['forwarding', 'ordering', 'issued', 'failed'])

/** One serving server's part in the request, kept so its status line can be written again. */
export type RosterEntry = {
  serverId: string
  label: string
  role: 'issuer' | 'helper' | 'skipped'
  /** Why a `skipped` server did not take part. */
  skip?: 'offline' | 'not_in_dns' | 'old_daemon'
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
  /** The address each helper is checked at (the issuing server tries it before asking the authority). */
  helperAddresses: Array<{ serverId: string; address: string }>
  /** When orders were started, newest last; the attempt cap counts these. */
  attemptTimes: string[]
  /** Do not start another attempt before this time (back-off). */
  nextAttemptAt: string | null
  /** The authority's directory this request uses. */
  directory: 'production' | 'staging'
  phase: HttpIssuancePhase
  /** When `acme-issue-request` was sent; null while the helpers are still answering. */
  orderSentAt: string | null
  /** The last event the issuing server reported. */
  lastEventAt: string | null
  /** The pair for this request was stored (it arrives by the capture call). */
  capturedAt: string | null
  /** Names of the request that a stored pair covers (a daemon reports one pair per name). */
  coveredNames: string[]
  /** The issuing server said `issued` (the request closes once the pair is stored too). */
  issuedEventAt: string | null
  /** Leaf expiry the issuing server reported (ISO 8601). */
  notAfterIso: string | null
  /** A plain reason when the attempt failed. */
  lastError: string | null
  /** Failed attempts in a row since the last good certificate; sets the back-off. */
  consecutiveFailures: number
  /** The server that failed the last attempt; the next attempt prefers another one. */
  avoidServerId: string | null
  /** When the sealed pair was queued to the serving servers; null until then. */
  deliveredAt: string | null
  /** The serving servers and their parts, for the per-server status lines. */
  roster: RosterEntry[]
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

const ROSTER_ROLES: ReadonlySet<string> = new Set(['issuer', 'helper', 'skipped'])
const SKIP_REASONS: ReadonlySet<string> = new Set(['offline', 'not_in_dns', 'old_daemon'])

function readRoster(value: unknown): RosterEntry[] {
  if (!Array.isArray(value)) return []
  const out: RosterEntry[] = []
  for (const item of value) {
    const r = record(item)
    const serverId = text(r?.serverId)
    const label = text(r?.label)
    if (!r || !serverId || !label || typeof r.role !== 'string' || !ROSTER_ROLES.has(r.role)) {
      continue
    }
    const skip = typeof r.skip === 'string' && SKIP_REASONS.has(r.skip) ? r.skip : undefined
    out.push({
      serverId,
      label,
      role: r.role as RosterEntry['role'],
      ...(skip ? { skip: skip as RosterEntry['skip'] } : {}),
    })
  }
  return out
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

function readHelperAddresses(value: unknown): Array<{ serverId: string; address: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const r = record(item)
    const serverId = text(r?.serverId)
    const address = text(r?.address)
    return serverId && address ? [{ serverId, address }] : []
  })
}

/** A request that has just been opened: nothing answered, nothing stored, no failures. */
export function newHttpIssuanceState(
  base: Pick<HttpIssuanceState, 'issuingServerId' | 'requestId' | 'startedAt' | 'startByAt'> &
    Partial<HttpIssuanceState>
): HttpIssuanceState {
  return {
    endedAt: null,
    forwards: [],
    helperAddresses: [],
    attemptTimes: [base.startedAt],
    nextAttemptAt: null,
    directory: 'production',
    phase: 'forwarding',
    orderSentAt: null,
    lastEventAt: null,
    capturedAt: null,
    coveredNames: [],
    issuedEventAt: null,
    notAfterIso: null,
    lastError: null,
    consecutiveFailures: 0,
    avoidServerId: null,
    deliveredAt: null,
    roster: [],
    ...base,
  }
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
    helperAddresses: readHelperAddresses(r.helperAddresses),
    attemptTimes: Array.isArray(r.attemptTimes)
      ? r.attemptTimes.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [],
    nextAttemptAt: text(r.nextAttemptAt),
    directory: r.directory === 'staging' ? 'staging' : 'production',
    phase:
      typeof r.phase === 'string' && PHASES.has(r.phase)
        ? (r.phase as HttpIssuancePhase)
        : 'forwarding',
    orderSentAt: text(r.orderSentAt),
    lastEventAt: text(r.lastEventAt),
    capturedAt: text(r.capturedAt),
    coveredNames: Array.isArray(r.coveredNames)
      ? r.coveredNames.filter((n): n is string => typeof n === 'string')
      : [],
    issuedEventAt: text(r.issuedEventAt),
    notAfterIso: text(r.notAfterIso),
    lastError: text(r.lastError),
    consecutiveFailures:
      typeof r.consecutiveFailures === 'number' && r.consecutiveFailures > 0
        ? Math.floor(r.consecutiveFailures)
        : 0,
    avoidServerId: text(r.avoidServerId),
    deliveredAt: text(r.deliveredAt),
    roster: readRoster(r.roster),
  }
}

/** The metadata object with the private state replaced; nothing else is touched. */
export function withHttpIssuanceState(
  metadata: unknown,
  state: HttpIssuanceState
): Record<string, unknown> {
  return { ...record(metadata), [HTTP_CERT_KEY]: state }
}

/**
 * The request after its pair was stored. It closes at once when the issuing
 * server already said `issued` and every name of the request has a stored pair;
 * otherwise it stays open, so the pairs (one per name) and the event may arrive
 * in any order.
 */
export function afterCapture(
  state: HttpIssuanceState,
  now: Date,
  covered: readonly string[] = [],
  expected: readonly string[] = []
): HttpIssuanceState {
  const at = now.toISOString()
  // A late pair for another name, inside the grace window after the close.
  if (state.endedAt !== null) {
    return { ...state, coveredNames: [...new Set([...state.coveredNames, ...covered])] }
  }
  const next = {
    ...state,
    capturedAt: at,
    coveredNames: [...new Set([...state.coveredNames, ...covered])],
  }
  return next.issuedEventAt !== null && allNamesCovered(next, expected)
    ? closedAsIssued(next, at)
    : next
}

/** Every name the request was for has a stored pair (a request for no names has nothing to wait for). */
export function allNamesCovered(state: HttpIssuanceState, expected: readonly string[]): boolean {
  return expected.every((name) => state.coveredNames.includes(name))
}

/** The request closed with a stored pair: nothing left to wait for, failures forgotten. */
export function closedAsIssued(state: HttpIssuanceState, at: string): HttpIssuanceState {
  return {
    ...state,
    phase: 'issued',
    endedAt: at,
    lastError: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    avoidServerId: null,
  }
}

/** How long after a request closes as issued a late pair for another of its names is still accepted. */
export const LATE_PAIR_GRACE_MS = 10 * 60_000

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
  if (state.endedAt !== null) {
    // A daemon reports one pair per name, so the last name's pair may arrive just
    // after the request closed as issued. Only the asked server, and only briefly.
    const closedAt = Date.parse(state.endedAt)
    const late =
      state.phase === 'issued' &&
      !Number.isNaN(closedAt) &&
      call.now.getTime() < closedAt + LATE_PAIR_GRACE_MS
    if (!late) return { ok: false, reason: 'closed' }
    return state.issuingServerId === call.serverId
      ? { ok: true }
      : { ok: false, reason: 'wrong_server' }
  }
  const until = Date.parse(state.startByAt)
  if (Number.isNaN(until) || call.now.getTime() >= until) return { ok: false, reason: 'expired' }
  if (state.issuingServerId !== call.serverId) return { ok: false, reason: 'wrong_server' }
  return { ok: true }
}
