import { assert, assertEquals } from '@std/assert'
import {
  createInMemoryMetricsGate,
  decideAdmission,
  GATE_EVENTS_PER_HOUR,
  GATE_MIN_GAP_SECONDS,
  GATE_SAMPLE_BURST,
  type GateDecision,
  type GateState,
} from './ingest-gate.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const T0 = Date.parse('2026-10-07T12:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

/** A gate whose clock the test moves; `receivedAt` is when the server's request lands. */
function gateWithClock() {
  let now = T0
  const gate = createInMemoryMetricsGate(() => now)
  return {
    gate,
    advance(seconds: number) {
      now += seconds * 1000
    },
  }
}

function stored(decision: GateDecision): boolean {
  return decision.stored
}

const SERVER = '11111111-2222-4333-8444-555555555555'

test('the first sample is stored, the same timestamp again is a duplicate, an earlier one a replay', async () => {
  const { gate } = gateWithClock()
  assertEquals(await gate.admit(SERVER, at(0), 0), { stored: true, eventsAllowed: 0 })
  const again = await gate.admit(SERVER, at(0), 0)
  assertEquals(again.stored, false)
  if (!again.stored) assertEquals(again.reason, 'duplicate')
  const replay = await gate.admit(SERVER, at(-60), 0)
  assertEquals(replay.stored, false)
  if (!replay.stored) assertEquals(replay.reason, 'duplicate')
})

test('a duplicate leaves the remembered state exactly as it was', () => {
  const state: GateState = {
    lastSampledMs: T0,
    sampleTokens: 3,
    eventTokens: 50,
    refreshedMs: T0,
  }
  const result = decideAdmission(state, { sampledAt: at(0), eventCount: 5 }, T0 + 1000)
  assertEquals(result.decision.stored, false)
  assertEquals(result.next, state)
})

test('an unreadable sample time is refused, never stored', () => {
  const result = decideAdmission(undefined, { sampledAt: 'not a time', eventCount: 0 }, T0)
  assertEquals(result.decision.stored, false)
  assertEquals(result.next, undefined)
})

test('a sample a minute after the last is stored without spending the catch-up allowance', () => {
  let state: GateState | undefined
  for (let minute = 0; minute < 30; minute++) {
    const result = decideAdmission(
      state,
      { sampledAt: at(minute * 60), eventCount: 0 },
      T0 + minute * 60_000
    )
    assert(result.decision.stored, `minute ${minute}`)
    state = result.next
  }
  assertEquals(state!.sampleTokens, GATE_SAMPLE_BURST)
})

test('early samples spend the catch-up allowance, then are refused with a Retry-After', async () => {
  const { gate } = gateWithClock()
  const decisions: GateDecision[] = []
  for (let i = 0; i < 20; i++) decisions.push(await gate.admit(SERVER, at(i * 2), 0))
  // The first sample, plus the burst of early ones; the rest are refused.
  assertEquals(decisions.filter(stored).length, 1 + GATE_SAMPLE_BURST)
  const refused = decisions.at(-1)!
  assertEquals(refused.stored, false)
  if (!refused.stored) {
    assertEquals(refused.reason, 'too_soon')
    assert(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60)
  }
})

test('the catch-up allowance refills one sample a minute', async () => {
  const { gate, advance } = gateWithClock()
  for (let i = 0; i <= GATE_SAMPLE_BURST; i++) await gate.admit(SERVER, at(i), 0)
  assertEquals(stored(await gate.admit(SERVER, at(10), 0)), false)
  advance(61)
  assertEquals(stored(await gate.admit(SERVER, at(11), 0)), true)
})

test('a flood of parallel samples for the same minute stores at most the first plus the burst', async () => {
  const { gate } = gateWithClock()
  const decisions = await Promise.all(
    Array.from({ length: GATE_MIN_GAP_SECONDS - 5 }, (_, i) => gate.admit(SERVER, at(i), 0))
  )
  assert(decisions.filter(stored).length <= 1 + GATE_SAMPLE_BURST)
})

test('events are stored while the hourly budget lasts, then dropped; the sample itself is still stored', async () => {
  // All ten land at once (a daemon replaying a backlog), so nothing refills in between.
  const { gate } = gateWithClock()
  let allowed = 0
  for (let minute = 0; minute < 10; minute++) {
    const decision = await gate.admit(SERVER, at(minute * 60), 16)
    assert(decision.stored)
    if (decision.stored) allowed += decision.eventsAllowed
  }
  // 10 samples of 16 events is 160, against a budget of 120 an hour.
  assertEquals(allowed, GATE_EVENTS_PER_HOUR)
  const last = await gate.admit(SERVER, at(600), 16)
  assert(last.stored)
  if (last.stored) assert(last.eventsAllowed < 16)
})

test('servers are counted separately', async () => {
  const { gate } = gateWithClock()
  const other = '99999999-2222-4333-8444-555555555555'
  assert(stored(await gate.admit(SERVER, at(0), 0)))
  assert(stored(await gate.admit(other, at(0), 0)))
  assertEquals(stored(await gate.admit(SERVER, at(0), 0)), false)
})

test('the 50 s on-time gap is what separates a regular sample from an early one', () => {
  const base = decideAdmission(undefined, { sampledAt: at(0), eventCount: 0 }, T0)
  const onTime = decideAdmission(
    base.next,
    { sampledAt: at(GATE_MIN_GAP_SECONDS), eventCount: 0 },
    T0
  )
  assertEquals(onTime.next!.sampleTokens, GATE_SAMPLE_BURST)
  const early = decideAdmission(
    base.next,
    { sampledAt: at(GATE_MIN_GAP_SECONDS - 1), eventCount: 0 },
    T0
  )
  assertEquals(early.next!.sampleTokens, GATE_SAMPLE_BURST - 1)
})
