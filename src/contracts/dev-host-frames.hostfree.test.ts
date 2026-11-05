/**
 * `dev-host-status`, `dev-host-action` and `dev-host-action-result` (feature
 * `dev-host-v1`): frame validation, envelope mapping and the request outcome.
 */
import { assert, assertEquals } from '@std/assert'
import { deriveInboundOutcome } from '../daemon/cell/inbound-outcome.ts'
import {
  DAEMON_WIRE_FEATURES,
  DEV_HOST_FEATURE,
  MIN_SUPPORTED_DAEMON_VERSION,
} from '../lib/version-wire.ts'
import {
  DAEMON_INBOUND_ALLOWED,
  type DevHostPart,
  type DevHostStatus,
  isDevHostStatus,
  MAX_DEV_HOST_DIRTY_ENTRIES,
  MAX_DEV_HOST_LOG_TAIL_LINES,
  MAX_DEV_HOST_PARTS,
  outboundEnvelopeToWireMessage,
  validateDaemonInboundEnvelope,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from './cell-protocol.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AT = '2026-11-03T12:00:00.000Z'
const HEAD = 'a'.repeat(40)

function part(overrides: Partial<DevHostPart> = {}): DevHostPart {
  return {
    name: 'control-plane',
    unit: 'turbopanel-instance.service',
    branch: 'trunk',
    onTrunk: true,
    headCommit: HEAD,
    runningCommit: null,
    behindBy: 3,
    dirty: {
      files: 1,
      blocking: false,
      kinds: [{ path: 'website/next-env.d.ts', kind: 'generated' }],
    },
    restartNeeded: false,
    setupNeeded: { install: true },
    active: true,
    ...overrides,
  }
}

function status(overrides: Partial<DevHostStatus> = {}): DevHostStatus {
  return {
    parts: [part(), part({ name: 'daemon', unit: 'turbopaneld.service', runningCommit: HEAD })],
    lastFetchAt: AT,
    job: {
      id: 'job-1',
      action: 'update',
      state: 'running',
      step: 'pull',
      steps: [
        { name: 'fetch', state: 'done' },
        { name: 'pull', state: 'running', detail: 'turbopanel' },
      ],
      startedAt: AT,
      endedAt: null,
      logTail: [],
    },
    ...overrides,
  }
}

function frame(value: unknown): string {
  return JSON.stringify(value)
}

test('dev-host-v1 is advertised and raised no floor', () => {
  assertEquals(DEV_HOST_FEATURE, 'dev-host-v1')
  assert((DAEMON_WIRE_FEATURES as readonly string[]).includes(DEV_HOST_FEATURE))
  // The floor moved for sealed secrets, not for dev-host-v1.
  assertEquals(MIN_SUPPORTED_DAEMON_VERSION, '0.1.18')
})

test('dev-host-status and dev-host-action-result are allowed inbound; the action is not', () => {
  const allowed = DAEMON_INBOUND_ALLOWED as ReadonlySet<string>
  assert(allowed.has('dev-host-status'))
  assert(allowed.has('dev-host-action-result'))
  assertEquals(allowed.has('dev-host-action'), false)
})

test('a well-formed dev-host-status is accepted and is fire-and-forget', () => {
  const result = validateDaemonInboundFrame(
    frame({ type: 'dev-host-status', status: status(), at: AT })
  )
  assert(result.ok)
  assertEquals(result.message.type, 'dev-host-status')
  assertEquals(wireMessageToInboundEnvelope(result.message), null)
})

test('a status with no fetch yet, no job and a migrate count is accepted', () => {
  const s = status({
    lastFetchAt: null,
    job: null,
    parts: [
      part({
        setupNeeded: { migrate: { pending: 2 } },
        blockedReason: 'not possible to fast-forward',
      }),
    ],
  })
  assert(isDevHostStatus(s))
  assert(validateDaemonInboundFrame(frame({ type: 'dev-host-status', status: s, at: AT })).ok)
})

test('unknown enum values from a newer daemon are kept', () => {
  const s = status({ parts: [part({ name: 'docs' as DevHostPart['name'] })] })
  assert(isDevHostStatus(s))
})

test('a malformed or oversized status is ignored, never a socket rejection', () => {
  const bad: unknown[] = [
    null,
    { parts: 'x', lastFetchAt: null, job: null },
    status({ parts: Array.from({ length: MAX_DEV_HOST_PARTS + 1 }, () => part()) }),
    status({
      parts: [
        part({
          dirty: {
            files: 99,
            blocking: true,
            kinds: Array.from({ length: MAX_DEV_HOST_DIRTY_ENTRIES + 1 }, (_, i) => ({
              path: `f${i}`,
              kind: 'content' as const,
            })),
          },
        }),
      ],
    }),
    status({ parts: [part({ behindBy: -1 })] }),
    status({ parts: [part({ runningCommit: 7 as unknown as string })] }),
    status({ parts: [part({ setupNeeded: { migrate: { pending: 1.5 } } })] }),
    status({ lastFetchAt: 'yesterday' }),
    {
      ...status(),
      job: {
        ...status().job,
        logTail: Array.from({ length: MAX_DEV_HOST_LOG_TAIL_LINES + 1 }, () => 'line'),
      },
    },
    { ...status(), job: { ...status().job, endedAt: 'soon' } },
  ]
  for (const value of bad) {
    assertEquals(isDevHostStatus(value), false)
    const result = validateDaemonInboundFrame(
      frame({ type: 'dev-host-status', status: value, at: AT })
    )
    assertEquals(result.ok, false)
    if (!result.ok) assertEquals(result.ignored, true)
  }
})

test('a dev-host-status without a valid at is rejected like any other frame', () => {
  const result = validateDaemonInboundFrame(
    frame({ type: 'dev-host-status', status: status(), at: 'now' })
  )
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.ignored, false)
})

test('dev-host-action goes out with the request id and the action only', () => {
  const message = outboundEnvelopeToWireMessage({
    kind: 'dev-host-action',
    deliveryId: 'delivery-1',
    requestId: 'request-1',
    action: 'restart',
    at: AT,
  })
  assertEquals(message, { type: 'dev-host-action', id: 'request-1', action: 'restart', at: AT })
})

test('an accepted dev-host-action-result completes the request with the job id', () => {
  const result = validateDaemonInboundFrame(
    frame({ type: 'dev-host-action-result', id: 'request-1', ok: true, jobId: 'job-9', at: AT })
  )
  assert(result.ok)
  const envelope = wireMessageToInboundEnvelope(result.message)
  assert(envelope)
  assertEquals(validateDaemonInboundEnvelope(envelope), { ok: true })
  assertEquals(deriveInboundOutcome(envelope), {
    status: 'done',
    result: { ok: true, jobId: 'job-9', error: undefined },
  })
})

test('a refused dev-host-action-result fails the request with the reason', () => {
  const result = validateDaemonInboundFrame(
    frame({
      type: 'dev-host-action-result',
      id: 'request-1',
      ok: false,
      error: 'job_running',
      at: AT,
    })
  )
  assert(result.ok)
  const envelope = wireMessageToInboundEnvelope(result.message)
  assert(envelope)
  const outcome = deriveInboundOutcome(envelope)
  assertEquals(outcome?.status, 'failed')
  assertEquals(outcome?.error, 'job_running')
})

test('a dev-host-action-result with a bad job id is rejected', () => {
  const result = validateDaemonInboundFrame(
    frame({ type: 'dev-host-action-result', id: 'request-1', ok: true, jobId: '', at: AT })
  )
  assertEquals(result.ok, false)
  const forged = validateDaemonInboundEnvelope({
    kind: 'dev-host-action-result',
    requestId: 'request-1',
    at: AT,
    ok: true,
    jobId: 'x'.repeat(500),
  })
  assertEquals(forged.ok, false)
})
