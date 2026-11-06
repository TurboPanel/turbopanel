import { assert, assertEquals } from '@std/assert'
import {
  applyForwardReports,
  decideOpen,
  failedState,
  mayReplaceKey,
  nextStateForEvent,
  publicMarker,
  READY_WAIT_MS,
  renewalDue,
} from './progress.ts'
import { serverStatusLines } from './status-text.ts'
import type { HttpIssuanceState } from './state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const T0 = new Date('2026-11-01T12:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

function open(over: Partial<HttpIssuanceState> = {}): HttpIssuanceState {
  return {
    issuingServerId: 'a',
    requestId: 'req_1',
    startedAt: T0.toISOString(),
    startByAt: at(30 * 60_000).toISOString(),
    endedAt: null,
    forwards: [
      { serverId: 'b', outcome: 'pending', reason: null, at: null },
      { serverId: 'c', outcome: 'pending', reason: null, at: null },
    ],
    helperAddresses: [
      { serverId: 'b', address: '203.0.113.2' },
      { serverId: 'c', address: '203.0.113.3' },
    ],
    attemptTimes: [T0.toISOString()],
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
    endsSentAt: null,
    centralPair: false,
    issueTimes: [],
    renewAt: null,
    roster: [
      { serverId: 'a', label: 'Server A', role: 'issuer' },
      { serverId: 'b', label: 'Server B', role: 'helper' },
      { serverId: 'c', label: 'Server C', role: 'helper' },
      { serverId: 'd', label: 'Server D', role: 'skipped', skip: 'offline' },
    ],
    ...over,
  }
}

test('the order waits for every helper, then goes out', () => {
  assertEquals(decideOpen(open(), at(30_000)), { kind: 'wait' })
  const one = applyForwardReports(open(), [{ serverId: 'b', outcome: 'ready' }], at(10_000))
  assertEquals(decideOpen(one, at(30_000)), { kind: 'wait' })
  const both = applyForwardReports(one, [{ serverId: 'c', outcome: 'ready' }], at(20_000))
  assertEquals(decideOpen(both, at(30_000)), { kind: 'order', skip: [] })
})

test('a helper that never answers is left out after the wait', () => {
  const one = applyForwardReports(open(), [{ serverId: 'b', outcome: 'ready' }], at(10_000))
  assertEquals(decideOpen(one, at(READY_WAIT_MS)), { kind: 'order', skip: ['c'] })
})

test('a helper that could not pass the proof path on stops the attempt before the order', () => {
  const state = applyForwardReports(
    open(),
    [{ serverId: 'b', outcome: 'failed', reason: 'Caddy would not reload' }],
    at(5_000)
  )
  const action = decideOpen(state, at(10_000))
  assertEquals(action, {
    kind: 'fail',
    reason: 'Server B could not pass the check along: Caddy would not reload',
    blameIssuer: false,
  })
  const failed = failedState(state, at(10_000), 'x', false)
  assertEquals(failed.avoidServerId, null)
})

test('a helper that could not be reached is left out and the order goes ahead', () => {
  const state = applyForwardReports(
    open(),
    [
      { serverId: 'b', outcome: 'skipped', reason: 'The server could not be reached.' },
      { serverId: 'c', outcome: 'ready' },
    ],
    at(5_000)
  )
  assertEquals(decideOpen(state, at(10_000)), { kind: 'order', skip: [] })
})

test('an answer from a server that was not asked, or arriving twice, changes nothing', () => {
  const state = open()
  assertEquals(
    applyForwardReports(state, [{ serverId: 'x', outcome: 'ready' }], at(1)).forwards,
    state.forwards
  )
  const once = applyForwardReports(state, [{ serverId: 'b', outcome: 'ready' }], at(1))
  const twice = applyForwardReports(
    once,
    [{ serverId: 'b', outcome: 'failed', reason: 'late' }],
    at(2)
  )
  assertEquals(twice.forwards[0].outcome, 'ready')
})

test('a silent issuing server fails the attempt and is avoided next time', () => {
  const ordering = open({ phase: 'ordering', orderSentAt: T0.toISOString(), forwards: [] })
  assertEquals(decideOpen(ordering, at(60_000)), { kind: 'wait' })
  const silent = decideOpen(ordering, at(3 * 60_000))
  assert(silent.kind === 'fail' && silent.blameIssuer)
  const failed = failedState(
    ordering,
    at(3 * 60_000),
    silent.kind === 'fail' ? silent.reason : '',
    true
  )
  assertEquals(failed.phase, 'failed')
  assertEquals(failed.avoidServerId, 'a')
  assertEquals(failed.consecutiveFailures, 1)
  assertEquals(failed.nextAttemptAt, at(3 * 60_000 + 10 * 60_000).toISOString())
})

test('after started, the server gets longer before it counts as silent', () => {
  const started = open({
    phase: 'ordering',
    orderSentAt: T0.toISOString(),
    lastEventAt: at(20_000).toISOString(),
    forwards: [],
  })
  assertEquals(decideOpen(started, at(5 * 60_000)), { kind: 'wait' })
  assertEquals(decideOpen(started, at(11 * 60_000)).kind, 'fail')
})

test('the whole request ends at its start-by time', () => {
  const ordering = open({
    phase: 'ordering',
    orderSentAt: T0.toISOString(),
    lastEventAt: at(29 * 60_000).toISOString(),
    forwards: [],
  })
  assertEquals(decideOpen(ordering, at(30 * 60_000)).kind, 'fail')
})

test('a finished order whose pair never arrives is given up', () => {
  const issued = open({
    phase: 'ordering',
    forwards: [],
    issuedEventAt: T0.toISOString(),
    lastEventAt: T0.toISOString(),
  })
  assertEquals(decideOpen(issued, at(60_000)), { kind: 'wait' })
  assertEquals(decideOpen(issued, at(6 * 60_000)).kind, 'fail')
})

test('events: started, failed and issued in either order with the pair', () => {
  const base = open({ phase: 'ordering', orderSentAt: T0.toISOString(), forwards: [] })
  const started = nextStateForEvent(base, { stage: 'started' }, at(1000))
  assertEquals(started.lastEventAt, at(1000).toISOString())
  const issuedFirst = nextStateForEvent(
    started,
    { stage: 'issued', notAfterIso: '2027-01-30T00:00:00.000Z' },
    at(2000)
  )
  assertEquals(issuedFirst.endedAt, null)
  assertEquals(issuedFirst.issuedEventAt, at(2000).toISOString())
  const captured = { ...started, capturedAt: at(1500).toISOString() }
  const closed = nextStateForEvent(captured, { stage: 'issued' }, at(2000))
  assertEquals(closed.phase, 'issued')
  assertEquals(closed.endedAt, at(2000).toISOString())
  const failed = nextStateForEvent(
    started,
    { stage: 'failed', reason: 'rateLimited: too many certificates' },
    at(2000)
  )
  assertEquals(failed.phase, 'failed')
  assertEquals(failed.nextAttemptAt, at(2000 + 3_600_000).toISOString())
  const after = nextStateForEvent(failed, { stage: 'issued' }, at(3000))
  assert(after === failed)
})

test('status lines describe each server and the public marker carries them', () => {
  const state = applyForwardReports(
    open(),
    [
      { serverId: 'b', outcome: 'ready' },
      { serverId: 'c', outcome: 'failed', reason: 'No port 80' },
    ],
    at(1)
  )
  const lines = serverStatusLines({ ...state, phase: 'ordering' })
  assertEquals(
    lines.map((l) => l.text),
    [
      'Server A is ordering the certificate.',
      'Server B passed the check along to Server A.',
      'Server C could not pass the check along: No port 80',
      'Server D is offline. It will get the certificate when it is back.',
    ]
  )
  const marker = publicMarker({ lastError: 'old' }, { ...state, phase: 'ordering' })
  assertEquals(marker.stage, 'ordering')
  assertEquals(marker.managedBy, 'server')
  assertEquals(marker.challengeType, 'http-01')
  assertEquals(marker.lastError, undefined)
  assertEquals(marker.serverStatus?.length, 4)
})

test('no status line uses alarming words', () => {
  const failed = failedState(open(), at(1), 'The server did not answer the order.', true)
  const all = serverStatusLines(failed)
    .map((l) => l.text)
    .join(' ')
  assert(!/compromis|breach|leak|hack/i.test(all))
})

test('renewal is due only for a pair the flow ordered, once its renewal time has come', () => {
  const state = open({
    centralPair: true,
    renewAt: at(1000).toISOString(),
    endedAt: T0.toISOString(),
    phase: 'issued',
  })
  assertEquals(renewalDue(state, at(999)), false)
  assertEquals(renewalDue(state, at(1000)), true)
  assertEquals(renewalDue({ ...state, centralPair: false }, at(5000)), false)
  assertEquals(renewalDue(null, at(5000)), false)
  assertEquals(renewalDue({ ...state, renewAt: null }, at(1)), true)
})

test('Replace Key: once a day, five a week, never while an order runs, never without a certificate', () => {
  const day = 86_400_000
  const issued = (offsetsDays: number[]) =>
    open({
      endedAt: T0.toISOString(),
      phase: 'issued',
      issueTimes: offsetsDays.map((d) => new Date(T0.getTime() - d * day).toISOString()),
    })
  assertEquals(mayReplaceKey(issued([30]), true, T0), { ok: true, leftThisWeek: 5 })
  assertEquals(mayReplaceKey(null, true, T0), { ok: true, leftThisWeek: 5 })
  assertEquals(mayReplaceKey(issued([30]), false, T0), {
    ok: false,
    reason: 'no_certificate',
    leftThisWeek: 5,
  })
  const soon = mayReplaceKey(issued([0.5]), true, T0)
  assert(!soon.ok && soon.reason === 'too_soon' && soon.leftThisWeek === 4)
  assertEquals(
    !soon.ok && soon.notBefore?.toISOString(),
    new Date(T0.getTime() + day / 2).toISOString()
  )
  assertEquals(mayReplaceKey(issued([2]), true, T0), { ok: true, leftThisWeek: 4 })
  const full = mayReplaceKey(issued([6, 5, 4, 3, 2]), true, T0)
  assert(!full.ok && full.reason === 'weekly_limit' && full.leftThisWeek === 0)
  assertEquals(
    !full.ok && full.notBefore?.toISOString(),
    new Date(T0.getTime() + day).toISOString()
  )
  assert(!mayReplaceKey(open({ phase: 'ordering' }), true, T0).ok)
  assertEquals(mayReplaceKey(issued([8, 9]), true, T0), { ok: true, leftThisWeek: 5 })
})

test('the issued event does not close a two-name request until both names have a pair', () => {
  const names = ['a.example.com', 'www.a.example.com']
  const base = open({
    phase: 'ordering',
    forwards: [],
    coveredNames: ['a.example.com'],
    capturedAt: T0.toISOString(),
  })
  const event = { stage: 'issued' as const }
  assertEquals(nextStateForEvent(base, event, at(1000), names).endedAt, null)
  const covered = { ...base, coveredNames: names }
  assertEquals(nextStateForEvent(covered, event, at(1000), names).phase, 'issued')
})

test('a stored pair with a lost issued event closes the request after a minute', () => {
  const names = ['a.example.com']
  const state = open({
    phase: 'ordering',
    forwards: [],
    orderSentAt: T0.toISOString(),
    capturedAt: T0.toISOString(),
    coveredNames: names,
  })
  assertEquals(decideOpen(state, at(30_000), names), { kind: 'wait' })
  assertEquals(decideOpen(state, at(60_000), names), { kind: 'close' })
  // Not every name stored, or no names known: no early close.
  assertEquals(decideOpen(state, at(60_000), [...names, 'www.a.example.com']).kind, 'wait')
  assertEquals(decideOpen(state, at(60_000)).kind, 'wait')
  // Still true near the end of the request, before the time limit fails it.
  assertEquals(decideOpen(state, at(29 * 60_000), names), { kind: 'close' })
})
