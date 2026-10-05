import { assertEquals } from '@std/assert'
import { deriveInboundOutcome } from './inbound-outcome.ts'
import type { DaemonInboundEnvelope } from '../../contracts/cell-protocol.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const AT = '2020-01-01T00:00:00.000Z'
const REQUEST_ID = '00000000-0000-4000-8000-000000000001'
const TEST_PUBLIC_IPV4 = '203.0.113.1' // RFC 5737 TEST-NET-3

test('deriveInboundOutcome maps addresses-result to done', () => {
  const ips = [
    {
      address: TEST_PUBLIC_IPV4,
      version: 4 as const,
      scope: 'public' as const,
    },
  ]
  assertEquals(
    deriveInboundOutcome({
      kind: 'addresses-result',
      requestId: REQUEST_ID,
      at: AT,
      ips,
    }),
    { status: 'done', result: { ips } }
  )
})

test('deriveInboundOutcome maps managed-logs-result done and failed', () => {
  const done: DaemonInboundEnvelope = {
    kind: 'managed-logs-result',
    requestId: REQUEST_ID,
    at: AT,
    logs: 'ok',
  }
  assertEquals(deriveInboundOutcome(done), {
    status: 'done',
    result: { logs: 'ok' },
  })
  assertEquals(deriveInboundOutcome({ ...done, error: 'boom' }), {
    status: 'failed',
    result: { logs: 'ok' },
    error: 'boom',
  })
})

test('deriveInboundOutcome maps container-logs-result done and failed', () => {
  const done: DaemonInboundEnvelope = {
    kind: 'container-logs-result',
    requestId: REQUEST_ID,
    at: AT,
    logs: 'line\n',
  }
  assertEquals(deriveInboundOutcome(done), {
    status: 'done',
    result: { logs: 'line\n' },
  })
  assertEquals(deriveInboundOutcome({ ...done, error: 'not owned' }), {
    status: 'failed',
    result: { logs: 'line\n' },
    error: 'not owned',
  })
})

test('deriveInboundOutcome maps fabric-paths-result done and failed', () => {
  const paths = [{ publicKey: 'pk', health: 'healthy' as const }]
  const done: DaemonInboundEnvelope = {
    kind: 'fabric-paths-result',
    requestId: REQUEST_ID,
    at: AT,
    paths,
  }
  assertEquals(deriveInboundOutcome(done), {
    status: 'done',
    result: { paths },
  })
  assertEquals(deriveInboundOutcome({ ...done, error: 'probe failed' }), {
    status: 'failed',
    result: { paths },
    error: 'probe failed',
  })
})

test('deriveInboundOutcome maps repo-read-result done and failed', () => {
  const files = [
    {
      path: 'package.json',
      found: true,
      content: '{}',
      bytes: 2,
    },
  ]
  const entries = [{ path: '.', kind: 'dir' }]
  assertEquals(
    deriveInboundOutcome({
      kind: 'repo-read-result',
      requestId: REQUEST_ID,
      at: AT,
      ok: true,
      commitSha: 'deadbeef',
      files,
      entries,
    }),
    {
      status: 'done',
      result: {
        ok: true,
        commitSha: 'deadbeef',
        files,
        entries,
        error: undefined,
      },
    }
  )
  assertEquals(
    deriveInboundOutcome({
      kind: 'repo-read-result',
      requestId: REQUEST_ID,
      at: AT,
      ok: false,
      error: 'git fetch failed',
    }),
    {
      status: 'failed',
      result: {
        ok: false,
        commitSha: undefined,
        files: undefined,
        entries: undefined,
        error: 'git fetch failed',
      },
      error: 'git fetch failed',
    }
  )
})

test('deriveInboundOutcome maps command-outcome with and without result', () => {
  assertEquals(
    deriveInboundOutcome({
      kind: 'command-outcome',
      requestId: REQUEST_ID,
      at: AT,
      ok: true,
      result: { hostname: 'box' },
    }),
    { status: 'done', result: { hostname: 'box' } }
  )
  assertEquals(
    deriveInboundOutcome({
      kind: 'command-outcome',
      requestId: REQUEST_ID,
      at: AT,
      ok: true,
    }),
    { status: 'done', result: { ok: true, error: undefined } }
  )
  assertEquals(
    deriveInboundOutcome({
      kind: 'command-outcome',
      requestId: REQUEST_ID,
      at: AT,
      ok: false,
      error: 'denied',
    }),
    {
      status: 'failed',
      result: { ok: false, error: 'denied' },
      error: 'denied',
    }
  )
})

test('deriveInboundOutcome maps ok-result kinds', () => {
  for (const kind of [
    'public-urls-update-result',
    'dev-sync-result',
    'tunnel-token-result',
    'update-result',
    'instance-update-result',
    'capability-plan-update-result',
    'capability-plan-clear-result',
  ] as const) {
    assertEquals(
      deriveInboundOutcome({
        kind,
        requestId: REQUEST_ID,
        at: AT,
        ok: true,
      }),
      { status: 'done', result: { ok: true, error: undefined } }
    )
    assertEquals(
      deriveInboundOutcome({
        kind,
        requestId: REQUEST_ID,
        at: AT,
        ok: false,
        error: `${kind} failed`,
      }),
      {
        status: 'failed',
        result: { ok: false, error: `${kind} failed` },
        error: `${kind} failed`,
      }
    )
  }
})

test('deriveInboundOutcome maps metrics-capabilities-result', () => {
  const capabilities = { sensors: { cpuTemperature: [] } }
  assertEquals(
    deriveInboundOutcome({
      kind: 'metrics-capabilities-result',
      requestId: REQUEST_ID,
      at: AT,
      ok: true,
      capabilities,
    }),
    { status: 'done', result: { capabilities } }
  )
  assertEquals(
    deriveInboundOutcome({
      kind: 'metrics-capabilities-result',
      requestId: REQUEST_ID,
      at: AT,
      ok: false,
      error: 'collect failed',
    }),
    {
      status: 'failed',
      result: { capabilities: undefined },
      error: 'collect failed',
    }
  )
})

test('deriveInboundOutcome returns null for command-ack', () => {
  assertEquals(
    deriveInboundOutcome({
      kind: 'command-ack',
      requestId: REQUEST_ID,
      at: AT,
      daemonReceivedAt: AT,
    }),
    null
  )
})

test('deriveInboundOutcome maps managed-health-result done and failed', () => {
  const member = {
    memberId: REQUEST_ID,
    role: 'replica',
    status: 'ready',
    replication: { state: 'streaming', observedAt: AT },
  }
  const done: DaemonInboundEnvelope = {
    kind: 'managed-health-result',
    requestId: REQUEST_ID,
    at: AT,
    ok: true,
    member,
  }
  assertEquals(deriveInboundOutcome(done), {
    status: 'done',
    result: { ok: true, member, error: undefined },
  })
  assertEquals(
    deriveInboundOutcome({
      kind: 'managed-health-result',
      requestId: REQUEST_ID,
      at: AT,
      ok: false,
      error: 'engine not running',
    }),
    {
      status: 'failed',
      result: { ok: false, member: undefined, error: 'engine not running' },
      error: 'engine not running',
    }
  )
})

test('deriveInboundOutcome maps repo-default-branch-result done, null branch and failed', () => {
  const base = { kind: 'repo-default-branch-result' as const, requestId: REQUEST_ID, at: AT }
  assertEquals(deriveInboundOutcome({ ...base, ok: true, defaultBranch: 'main' }), {
    status: 'done',
    result: { ok: true, defaultBranch: 'main', error: undefined },
  })
  assertEquals(deriveInboundOutcome({ ...base, ok: true, defaultBranch: null }), {
    status: 'done',
    result: { ok: true, defaultBranch: null, error: undefined },
  })
  assertEquals(deriveInboundOutcome({ ...base, ok: false, error: 'repo not found' }), {
    status: 'failed',
    result: { ok: false, defaultBranch: undefined, error: 'repo not found' },
    error: 'repo not found',
  })
})

const common = { requestId: REQUEST_ID, at: AT }

/**
 * One sample per inbound kind. Typed as a full Record, so adding a kind to
 * DaemonInboundEnvelope without a sample here fails type-checking.
 */
const SAMPLES: Record<DaemonInboundEnvelope['kind'], DaemonInboundEnvelope> = {
  'addresses-result': { kind: 'addresses-result', ...common, ips: [] },
  'managed-logs-result': { kind: 'managed-logs-result', ...common, logs: '' },
  'managed-health-result': { kind: 'managed-health-result', ...common, ok: true },
  'container-logs-result': { kind: 'container-logs-result', ...common, logs: '' },
  'repo-read-result': { kind: 'repo-read-result', ...common, ok: true },
  'repo-default-branch-result': {
    kind: 'repo-default-branch-result',
    ...common,
    ok: true,
    defaultBranch: 'main',
  },
  'fabric-paths-result': { kind: 'fabric-paths-result', ...common, paths: [] },
  'dev-sync-result': { kind: 'dev-sync-result', ...common, ok: true },
  'tunnel-token-result': { kind: 'tunnel-token-result', ...common, ok: true },
  'public-urls-update-result': { kind: 'public-urls-update-result', ...common, ok: true },
  'metrics-live-start-result': { kind: 'metrics-live-start-result', ...common, ok: true },
  'metrics-live-stop-result': { kind: 'metrics-live-stop-result', ...common, ok: true },
  'metrics-capabilities-result': { kind: 'metrics-capabilities-result', ...common, ok: true },
  'topology-overrides-update-result': {
    kind: 'topology-overrides-update-result',
    ...common,
    ok: true,
  },
  'capability-plan-update-result': { kind: 'capability-plan-update-result', ...common, ok: true },
  'capability-plan-clear-result': { kind: 'capability-plan-clear-result', ...common, ok: true },
  'deploy-cancel-result': { kind: 'deploy-cancel-result', ...common, ok: true },
  'update-result': { kind: 'update-result', ...common, ok: true },
  'instance-update-result': { kind: 'instance-update-result', ...common, ok: true },
  'command-ack': { kind: 'command-ack', ...common, daemonReceivedAt: AT },
  'command-outcome': { kind: 'command-outcome', ...common, ok: true },
}

test('deriveInboundOutcome has a mapping for every inbound kind except the non-terminal command-ack', () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const outcome = deriveInboundOutcome(sample)
    if (kind === 'command-ack') {
      assertEquals(outcome, null, 'command-ack is progress, not completion')
    } else {
      assertEquals(outcome?.status, 'done', `${kind} must map to a terminal outcome`)
    }
  }
})

test('deriveInboundOutcome treats an unknown kind as non-terminal', () => {
  assertEquals(deriveInboundOutcome({ kind: 'from-the-future', ...common } as never), null)
})

test('deriveInboundOutcome maps deploy-cancel-result done and failed', () => {
  const done: DaemonInboundEnvelope = {
    kind: 'deploy-cancel-result',
    requestId: REQUEST_ID,
    at: AT,
    ok: true,
    outcome: 'cancelling',
  }
  assertEquals(deriveInboundOutcome(done), {
    status: 'done',
    result: { ok: true, outcome: 'cancelling', error: undefined },
  })
  const failed = deriveInboundOutcome({ ...done, ok: false, outcome: undefined, error: 'boom' })
  assertEquals(failed?.status, 'failed')
})
