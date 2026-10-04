import { assertEquals } from '@std/assert'
import {
  bestState,
  decideConfirmation,
  type PortReach,
  type ProbeObservation,
  reachFromObservations,
} from './probe-decision.ts'

const test = Deno.test.bind(Deno)

function reach(
  port: number,
  role: PortReach['role'],
  state: PortReach['state'],
  ms: number | null = state === 'open' ? 10 : null
): PortReach {
  return { port, role, reason: `port ${port}`, state, ms }
}

test('baseline open and still open after: confirm, naming the ports that were checked', () => {
  const baseline = [reach(22, 'invariant', 'open'), reach(443, 'public', 'open')]
  assertEquals(decideConfirmation(baseline, baseline), { kind: 'confirm', checkedPorts: [22, 443] })
})

test('an invariant port that answered before and does not after: withhold, so the host undoes it', () => {
  const baseline = [reach(22, 'invariant', 'open'), reach(8443, 'invariant', 'open')]
  const after = [reach(22, 'invariant', 'timeout'), reach(8443, 'invariant', 'open')]
  const decision = decideConfirmation(baseline, after)
  assertEquals(decision.kind, 'withhold')
  assertEquals(decision.kind === 'withhold' && decision.cutPorts, [22])
})

test('a public port cut by the change also withholds', () => {
  const baseline = [reach(22, 'invariant', 'open'), reach(443, 'public', 'open')]
  const after = [reach(22, 'invariant', 'open'), reach(443, 'public', 'refused')]
  const decision = decideConfirmation(baseline, after)
  assertEquals(decision.kind === 'withhold' && decision.cutPorts, [443])
})

test('refused is never counted as reachable: a reject rule looks like a refusal', () => {
  const baseline = [reach(22, 'invariant', 'open')]
  assertEquals(decideConfirmation(baseline, [reach(22, 'invariant', 'refused')]).kind, 'withhold')
})

test('no reachable invariant port before the change: unavailable, so the manual Keep is the fallback', () => {
  for (const baseline of [
    [] as PortReach[],
    [reach(22, 'invariant', 'timeout'), reach(8443, 'invariant', 'blocked')],
    [reach(22, 'invariant', 'timeout'), reach(443, 'public', 'open')],
    [reach(22, 'informational', 'open')],
  ]) {
    assertEquals(decideConfirmation(baseline, baseline).kind, 'unavailable')
  }
})

test('a port nobody could reach before is not held against the change', () => {
  const baseline = [reach(22, 'invariant', 'open'), reach(8080, 'public', 'timeout')]
  const after = [reach(22, 'invariant', 'open'), reach(8080, 'public', 'timeout')]
  assertEquals(decideConfirmation(baseline, after), { kind: 'confirm', checkedPorts: [22] })
})

test('an informational port never gates, even when it answered before and not after', () => {
  const baseline = [reach(22, 'invariant', 'open'), reach(2222, 'informational', 'open')]
  const after = [reach(22, 'invariant', 'open'), reach(2222, 'informational', 'timeout')]
  assertEquals(decideConfirmation(baseline, after).kind, 'confirm')
})

test('a port missing from the after round counts as not reachable', () => {
  const baseline = [reach(22, 'invariant', 'open')]
  assertEquals(decideConfirmation(baseline, []).kind, 'withhold')
})

test('the best state across a server’s addresses wins', () => {
  assertEquals(bestState(['timeout', 'open', 'error']), 'open')
  assertEquals(bestState(['timeout', 'refused']), 'refused')
  assertEquals(bestState(['blocked', 'timeout']), 'timeout')
  assertEquals(bestState([]), 'error')
})

test('attempts are merged per planned port, with the fastest handshake', () => {
  const observations: ProbeObservation[] = [
    { address: 'a', port: 22, state: 'timeout', ms: null },
    { address: 'b', port: 22, state: 'open', ms: 40 },
    { address: 'c', port: 22, state: 'open', ms: 12 },
    { address: 'a', port: 443, state: 'refused', ms: null },
  ]
  const merged = reachFromObservations(
    [
      { port: 22, role: 'invariant', reason: 'SSH' },
      { port: 443, role: 'public', reason: 'Hosting HTTPS' },
      { port: 8443, role: 'invariant', reason: 'Control plane' },
    ],
    observations
  )
  assertEquals(
    merged.map((entry) => [entry.port, entry.state, entry.ms]),
    [
      [22, 'open', 12],
      [443, 'refused', null],
      [8443, 'blocked', null],
    ]
  )
})
