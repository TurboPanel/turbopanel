import { assertEquals } from '@std/assert'
import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import {
  evaluateFreshStandby,
  type FreshStandbyInput,
  failureStartedAtMs,
  MAX_FAILURE_SPAN_MS,
  parsePgLsn,
  pickMostAdvancedStandby,
} from './ha-fresh-standby.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PROBE_MS = 1_000_000
const FAILURE_MS = PROBE_MS - 20_000
const LSN = '0/3000148'

function cold(overrides: Partial<ManagedReplicationHealth> = {}): ManagedReplicationHealth {
  return {
    state: 'stopped',
    observedAt: new Date(PROBE_MS).toISOString(),
    receivedLsn: LSN,
    replayLsn: LSN,
    // Last streaming 25 s before the probe = 5 s before the failure start.
    lastStreaming: { at: 'x', ageMs: 25_000, receiveLagBytes: 0, lagSeconds: 900 },
    ...overrides,
  }
}

function judge(
  replication: ManagedReplicationHealth | null,
  extra: Partial<FreshStandbyInput> = {}
) {
  return evaluateFreshStandby({
    replication,
    probeStartedAtMs: PROBE_MS,
    failureStartedAtMs: FAILURE_MS,
    marginMs: 10_000,
    ...extra,
  })
}

function reason(verdict: ReturnType<typeof judge>): string {
  return verdict.accepted ? 'accepted' : verdict.reason
}

test('parsePgLsn orders LSNs numerically and rejects malformed text', () => {
  assertEquals(parsePgLsn('0/3000148'), 0x3000148n)
  assertEquals(parsePgLsn('1/0')! > parsePgLsn('0/FFFFFFFF')!, true)
  assertEquals(parsePgLsn('1a/ff'), parsePgLsn('1A/FF'))
  for (const bad of [undefined, '', '0/', '/1', '0/123456789', 'x/1', 7]) {
    assertEquals(parsePgLsn(bad), null)
  }
})

test('accepts a stopped standby seen streaming inside the margin, fully replayed, under the lag limits', () => {
  const verdict = judge(cold())
  assertEquals(verdict.accepted, true)
  if (verdict.accepted) {
    assertEquals(
      verdict.basis,
      'stopped; last streaming 5.0 s before failure start (margin 10 s); ' +
        'received = replayed = 0/3000148; last receive lag 0 B'
    )
  }
  // Exactly at the margin is still fresh.
  const edge = cold({ lastStreaming: { at: 'x', ageMs: 30_000, receiveLagBytes: 0 } })
  assertEquals(reason(judge(edge)), 'accepted')
})

test('refuses a receipt older than failure start minus the margin, or none at all', () => {
  assertEquals(
    reason(judge(cold({ lastStreaming: { at: 'x', ageMs: 30_001, receiveLagBytes: 0 } }))),
    'receipt_stale'
  )
  assertEquals(reason(judge(cold(), { marginMs: 0 })), 'receipt_stale')
  assertEquals(reason(judge(cold({ lastStreaming: undefined }))), 'receipt_unknown')
  assertEquals(
    reason(judge(cold({ lastStreaming: { at: 'x', ageMs: -1, receiveLagBytes: 0 } }))),
    'receipt_unknown'
  )
})

test('refuses replay behind the received LSN, or unknown LSNs', () => {
  assertEquals(reason(judge(cold({ replayLsn: '0/2FFC147' }))), 'replay_behind')
  assertEquals(reason(judge(cold({ receivedLsn: undefined }))), 'lsn_unknown')
  assertEquals(reason(judge(cold({ replayLsn: 'nope' }))), 'lsn_unknown')
})

test('refuses a last receive byte lag over the limit, or none recorded; ignores seconds since commit', () => {
  const at = { at: 'x', ageMs: 25_000 }
  const over = { ...at, receiveLagBytes: 64 * 1024 * 1024 + 1 }
  assertEquals(reason(judge(cold({ lastStreaming: over }))), 'last_lag_over_limit')
  const custom = { ...at, receiveLagBytes: 10 }
  assertEquals(
    reason(judge(cold({ lastStreaming: custom }), { maxLagBytes: 5 })),
    'last_lag_over_limit'
  )
  // Replay lag bytes are not the receive lag: still unknown.
  assertEquals(reason(judge(cold({ lastStreaming: { ...at, lagBytes: 0 } }))), 'last_lag_unknown')
  const nan = { ...at, receiveLagBytes: Number.NaN }
  assertEquals(reason(judge(cold({ lastStreaming: nan }))), 'last_lag_unknown')
  // An idle cluster: hours since the last commit, nothing behind.
  const idle = { ...at, receiveLagBytes: 0, lagBytes: 0, lagSeconds: 36_000 }
  assertEquals(reason(judge(cold({ lastStreaming: idle }))), 'accepted')
})

test('refuses no answer and anything that is not a disconnected standby', () => {
  assertEquals(reason(judge(null)), 'probe_unavailable')
  assertEquals(reason(judge(cold({ state: 'needs_resync' }))), 'not_a_standby')
  assertEquals(reason(judge(cold({ state: 'unknown' }))), 'not_a_standby')
  assertEquals(reason(judge(cold({ state: 'waiting' }))), 'accepted')
})

test('replay within 16 KiB of received (a partial record) still counts as replayed', () => {
  // 0x3000148 - 0x2FFC148 = 16 KiB exactly.
  const partial = judge(cold({ replayLsn: '0/2FFC148' }))
  assertEquals(reason(partial), 'accepted')
  if (partial.accepted) assertEquals(partial.basis.includes('(replay 16384 B behind)'), true)
  assertEquals(reason(judge(cold({ replayLsn: '0/3000100' }))), 'accepted')
  assertEquals(reason(judge(cold({ replayLsn: '0/2FFC147' }))), 'replay_behind')
  // Replay ahead of the receiver (local WAL) is not behind.
  assertEquals(reason(judge(cold({ replayLsn: '0/3000200' }))), 'accepted')
})

test('a standby still streaming at event time needs the lag gate AND a fresh receipt', () => {
  const streaming = {
    state: 'streaming',
    observedAt: new Date(PROBE_MS).toISOString(),
    lagBytes: 0,
    lastStreaming: { at: 'x', ageMs: 1_000, receiveLagBytes: 0 },
  }
  assertEquals(reason(judge(streaming)), 'accepted')
  assertEquals(reason(judge({ ...streaming, lagBytes: 128 * 1024 * 1024 })), 'lagging')
  // Silent link drop: still 'streaming', zero lag, nothing heard for 40 s.
  const dropped = { ...streaming, lastStreaming: { at: 'x', ageMs: 40_000, receiveLagBytes: 0 } }
  assertEquals(reason(judge(dropped)), 'receipt_stale')
  assertEquals(reason(judge({ ...streaming, lastStreaming: undefined })), 'receipt_unknown')
})

test('failureStartedAtMs anchors on the detector span and refuses a bad one', () => {
  assertEquals(failureStartedAtMs({ spanMs: 25_000 }, 100_000), 75_000)
  assertEquals(failureStartedAtMs({ spanMs: 0 }, 100_000), 100_000)
  assertEquals(failureStartedAtMs(undefined, 100_000), null)
  assertEquals(failureStartedAtMs({ spanMs: '25000' }, 100_000), null)
  assertEquals(failureStartedAtMs({ spanMs: -1 }, 100_000), null)
  assertEquals(failureStartedAtMs({ spanMs: MAX_FAILURE_SPAN_MS + 1 }, 100_000), null)
})

test('pickMostAdvancedStandby takes the highest received LSN, then the lowest ordinal', () => {
  const a = { id: 'a', ordinal: 2, receivedLsn: '0/3000100' }
  const b = { id: 'b', ordinal: 3, receivedLsn: '0/3000148' }
  const c = { id: 'c', ordinal: 4, receivedLsn: '0/3000148' }
  const d = { id: 'd', ordinal: 1, receivedLsn: undefined }
  assertEquals(pickMostAdvancedStandby([a, b, c, d])?.id, 'b')
  assertEquals(pickMostAdvancedStandby([c, b])?.id, 'b')
  assertEquals(pickMostAdvancedStandby([d, a])?.id, 'a')
  assertEquals(pickMostAdvancedStandby([]), null)
})

test('failureStartedAtMs refuses a span older than 10 minutes (an old incident)', () => {
  assertEquals(failureStartedAtMs({ spanMs: 10 * 60_000 }, 1_000_000), 400_000)
  assertEquals(failureStartedAtMs({ spanMs: 11 * 60_000 }, 1_000_000), null)
})

function mysqlReplica(overrides: Partial<ManagedReplicationHealth> = {}): ManagedReplicationHealth {
  return {
    state: 'reconnecting',
    observedAt: new Date(PROBE_MS).toISOString(),
    receivedGtid: 'uuid:1-9',
    executedGtid: 'uuid:1-9',
    fullyApplied: true,
    lastStreaming: { at: 'x', ageMs: 25_000 },
    ...overrides,
  }
}

for (const engine of ['mysql', 'mariadb']) {
  test(`${engine}: a reconnecting replica that applied everything it received is accepted`, () => {
    assertEquals(reason(judge(mysqlReplica(), { engine })), 'accepted')
  })

  test(`${engine}: unknown or false fullyApplied is never caught up`, () => {
    assertEquals(
      reason(judge(mysqlReplica({ fullyApplied: false }), { engine })),
      'not_fully_applied'
    )
    assertEquals(
      reason(judge(mysqlReplica({ fullyApplied: undefined }), { engine })),
      'not_fully_applied'
    )
  })

  test(`${engine}: last contact before the failure window, or none, refuses`, () => {
    assertEquals(
      reason(judge(mysqlReplica({ lastStreaming: { at: 'x', ageMs: 60_000 } }), { engine })),
      'receipt_stale'
    )
    assertEquals(
      reason(judge(mysqlReplica({ lastStreaming: undefined }), { engine })),
      'receipt_unknown'
    )
  })

  test(`${engine}: no answer and non-replica states refuse`, () => {
    assertEquals(reason(judge(null, { engine })), 'probe_unavailable')
    assertEquals(reason(judge(mysqlReplica({ state: 'primary' }), { engine })), 'not_a_standby')
    assertEquals(reason(judge(mysqlReplica({ state: 'unknown' }), { engine })), 'not_a_standby')
  })
}

test('mysql: still streaming needs fullyApplied and the lag gate', () => {
  const streaming = mysqlReplica({ state: 'streaming', lagSeconds: 0, lagBytes: 0 })
  assertEquals(reason(judge(streaming, { engine: 'mysql' })), 'accepted')
  assertEquals(
    reason(judge({ ...streaming, fullyApplied: false }, { engine: 'mysql' })),
    'not_fully_applied'
  )
  assertEquals(reason(judge({ ...streaming, lagSeconds: 3600 }, { engine: 'mysql' })), 'lagging')
})

test('postgres reading shape is not accepted without engine mysql (reconnecting is not a pg state)', () => {
  assertEquals(reason(judge(mysqlReplica(), { engine: 'postgres' })), 'not_a_standby')
})
