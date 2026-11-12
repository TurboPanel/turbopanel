import type { PendingRequestKind, PendingRequestStatus } from '../../contracts/cell.ts'
import type { DaemonInboundEnvelope } from '../../contracts/cell-protocol.ts'
import { redactUrlSecrets } from '../../features/upgrades/redact-url-secrets.ts'

/** Correlation status + payload derived from a terminal inbound envelope. */
export type InboundOutcome = {
  status: PendingRequestStatus
  result?: unknown
  error?: string
}

function inboundOutcomeFromError(result: unknown, error: string | undefined): InboundOutcome {
  if (error) return { status: 'failed', result, error }
  return { status: 'done', result }
}

function inboundOutcomeFromOk(
  ok: boolean,
  error: string | undefined,
  result: unknown
): InboundOutcome {
  if (ok) return { status: 'done', result }
  return { status: 'failed', result, error }
}

function commandOutcomePayload(
  inbound: Extract<DaemonInboundEnvelope, { kind: 'command-outcome' }>
): unknown {
  if (inbound.result === undefined) {
    return { ok: inbound.ok, error: inbound.error }
  }
  return inbound.result
}

function repoReadResultPayload(
  inbound: Extract<DaemonInboundEnvelope, { kind: 'repo-read-result' }>
): unknown {
  return {
    ok: inbound.ok,
    commitSha: inbound.commitSha,
    files: inbound.files,
    entries: inbound.entries,
    error: inbound.error,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The result with its own `error` text redacted; the same object when it has none. */
function redactResultError(result: unknown): unknown {
  if (!isRecord(result) || typeof result.error !== 'string') return result
  return { ...result, error: redactUrlSecrets(result.error) }
}

/**
 * The outcome as it may be stored: the `error` column and the `error` field of
 * the stored result both pass through {@link redactUrlSecrets}. Every message
 * kind goes through here, so none of them keeps the daemon's raw error text.
 */
function redactOutcome(outcome: InboundOutcome): InboundOutcome {
  const result = redactResultError(outcome.result)
  return {
    ...outcome,
    ...(outcome.result === undefined ? {} : { result }),
    ...(outcome.error === undefined ? {} : { error: redactUrlSecrets(outcome.error) }),
  }
}

/**
 * Map a daemon inbound envelope to a pending-request completion, with the
 * error text redacted (see {@link redactOutcome}).
 * Returns `null` for non-terminal kinds (`command-ack` and similar).
 *
 * `instance-acme-issuance-event` and `acme-issuance-event` are
 * fire-and-forget inbound messages, not envelopes. They never reach this
 * function. `public-urls-update` grew optional `hostnames` / `instanceAcme`
 * on the outbound side; its result kind is unchanged.
 *
 * `update-progress` and `command-progress` have no correlated request and
 * must not gain a case here. They are fire-and-forget progress, not a
 * completion of `update`, `instance-update` or `command-dispatch`.
 */
export function deriveInboundOutcome(inbound: DaemonInboundEnvelope): InboundOutcome | null {
  const outcome = deriveRawInboundOutcome(inbound)
  return outcome === null ? null : redactOutcome(outcome)
}

function deriveRawInboundOutcome(inbound: DaemonInboundEnvelope): InboundOutcome | null {
  switch (inbound.kind) {
    case 'addresses-result':
      return { status: 'done', result: { ips: inbound.ips } }
    case 'managed-logs-result':
    case 'container-logs-result':
      return inboundOutcomeFromError({ logs: inbound.logs }, inbound.error)
    case 'fabric-paths-result':
      return inboundOutcomeFromError({ paths: inbound.paths }, inbound.error)
    case 'managed-health-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        member: inbound.member,
        error: inbound.error,
      })
    case 'managed-permissions-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        permissions: inbound.permissions,
        error: inbound.error,
      })
    case 'server-network-check-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        results: inbound.results,
        error: inbound.error,
      })
    case 'dev-host-action-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        jobId: inbound.jobId,
        error: inbound.error,
      })
    case 'repo-read-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, repoReadResultPayload(inbound))
    case 'repo-default-branch-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        defaultBranch: inbound.defaultBranch,
        error: inbound.error,
      })
    case 'command-outcome':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, commandOutcomePayload(inbound))
    case 'public-urls-update-result':
    case 'dev-sync-result':
    case 'tunnel-token-result':
    case 'instance-update-result':
    case 'metrics-live-start-result':
    case 'metrics-live-stop-result':
    case 'topology-overrides-update-result':
    case 'capability-plan-update-result':
    case 'capability-plan-clear-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        error: inbound.error,
      })
    case 'update-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        error: inbound.error,
        ...(inbound.errorCode ? { errorCode: inbound.errorCode } : {}),
        ...(inbound.upgradeId ? { upgradeId: inbound.upgradeId } : {}),
      })
    case 'deploy-cancel-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        ok: inbound.ok,
        outcome: inbound.outcome,
        error: inbound.error,
      })
    case 'metrics-capabilities-result':
      return inboundOutcomeFromOk(inbound.ok, inbound.error, {
        capabilities: inbound.capabilities,
      })
    case 'command-ack':
      return null
    default:
      return unhandledInbound(inbound)
  }
}

/**
 * Compile-time guard: a new inbound kind must get a case (or be named
 * non-terminal) above. At run time an unknown kind is still non-terminal.
 */
function unhandledInbound(_inbound: never): null {
  return null
}

type InboundKind = DaemonInboundEnvelope['kind']

/**
 * The answers each request kind may receive. A pending request is completed
 * (or acked) only by one of these, so an answer frame of another kind that
 * names the request's id is refused: without this, any unsigned `*-result`
 * frame could complete a `command-dispatch` and skip the signature and
 * ratchet that `command-outcome` goes through. `command-ack` belongs to
 * `command-dispatch` only. Fire-and-forget requests (`echo` and the
 * certificate order messages, answered by their own events) take none.
 *
 * A `Record` over every outbound kind, so a new request kind does not compile
 * until it names its answers here.
 */
const REQUEST_ANSWER_KINDS: Readonly<Record<PendingRequestKind, readonly InboundKind[]>> = {
  'addresses-request': ['addresses-result'],
  'managed-logs-request': ['managed-logs-result'],
  'managed-health-request': ['managed-health-result'],
  'managed-permissions-request': ['managed-permissions-result'],
  'server-network-check-request': ['server-network-check-result'],
  'dev-host-action': ['dev-host-action-result'],
  'container-logs-request': ['container-logs-result'],
  'repo-read-request': ['repo-read-result'],
  'repo-default-branch-request': ['repo-default-branch-result'],
  'fabric-paths-request': ['fabric-paths-result'],
  'dev-sync': ['dev-sync-result'],
  'tunnel-token': ['tunnel-token-result'],
  'public-urls-update': ['public-urls-update-result'],
  'metrics-live-start': ['metrics-live-start-result'],
  'metrics-live-stop': ['metrics-live-stop-result'],
  'metrics-capabilities-request': ['metrics-capabilities-result'],
  'topology-overrides-update': ['topology-overrides-update-result'],
  'capability-plan-update': ['capability-plan-update-result'],
  'capability-plan-clear': ['capability-plan-clear-result'],
  'deploy-cancel': ['deploy-cancel-result'],
  update: ['update-result'],
  'instance-update': ['instance-update-result'],
  'acme-issue-request': [],
  'acme-proof-forward': [],
  'acme-proof-forward-end': [],
  echo: [],
  'command-dispatch': ['command-ack', 'command-outcome'],
}

/**
 * True when `inboundKind` is an answer the request of `requestKind` may
 * receive. An unknown or empty stored kind is never answered.
 */
export function inboundAnswersRequest(requestKind: string, inboundKind: string): boolean {
  if (!Object.hasOwn(REQUEST_ANSWER_KINDS, requestKind)) return false
  const allowed = REQUEST_ANSWER_KINDS[requestKind as PendingRequestKind]
  return (allowed as readonly string[]).includes(inboundKind)
}

/** The one warn line both runtimes log for an answer of the wrong kind. */
export function answerKindMismatchWarning(params: {
  serverId: string
  requestId: string
  requestKind: string
  inboundKind: string
}): string {
  return (
    `event=answer-kind-refused serverId=${params.serverId} ` +
    `requestId=${params.requestId} requestKind=${params.requestKind || 'unknown'} ` +
    `answerKind=${params.inboundKind}: an answer of this kind cannot complete this request`
  )
}
