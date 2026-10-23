/**
 * Host-free coverage for the automatic network fallback rules: who is blamed
 * for a failed round, and when a mark appears and goes.
 */

import { assertEquals } from '@std/assert'
import { parseUnreachableMarker, pinProbedDown } from './pin-link-state.ts'
import {
  nextProbeMarker,
  PROBE_FAILURES_TO_MARK_DOWN,
  PROBE_OKS_TO_CLEAR,
  probeMarkerOf,
  probeVerdicts,
  withProbeMarker,
} from './network-probe.ts'
import type {
  NetworkCheckPeerResult,
  NetworkCheckReport,
  NetworkCheckServerReport,
} from './server-network-check.ts'
import type { IpPinUnreachableMetadata } from './pin-link-state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000a2'
const C = '00000000-0000-4000-8000-0000000000a3'
const NOW = '2026-10-23T18:00:00.000Z'

function peer(
  peerServerId: string,
  result: NetworkCheckPeerResult['result']
): NetworkCheckPeerResult {
  return { peerServerId, address: '172.20.4.1', port: 22, result }
}

function server(
  serverId: string,
  peers: NetworkCheckPeerResult[],
  status: 'checked' | 'not_tested' = 'checked'
): NetworkCheckServerReport {
  return { serverId, status, peers }
}

function report(servers: NetworkCheckServerReport[]): NetworkCheckReport {
  return { datacenterId: 'dc', servers, unreachableCount: 0, notTestedCount: 0 }
}

test('a cut-off server fails, the servers that still reach each other stay ok', () => {
  const verdicts = probeVerdicts(
    report([
      server(A, [peer(B, 'not_reachable'), peer(C, 'not_reachable')]),
      server(B, [peer(A, 'not_reachable'), peer(C, 'reachable')]),
      server(C, [peer(A, 'not_reachable'), peer(B, 'reachable')]),
    ])
  )
  assertEquals(verdicts.get(A), 'fail')
  assertEquals(verdicts.get(B), 'ok')
  assertEquals(verdicts.get(C), 'ok')
})

test('with two servers and nothing getting through both are blamed', () => {
  const verdicts = probeVerdicts(
    report([server(A, [peer(B, 'not_reachable')]), server(B, [peer(A, 'not_reachable')])])
  )
  assertEquals([verdicts.get(A), verdicts.get(B)], ['fail', 'fail'])
})

test('a server that could not be asked is never blamed on the network', () => {
  const verdicts = probeVerdicts(
    report([
      server(A, [peer(B, 'not_tested')], 'not_tested'),
      server(B, [peer(A, 'not_reachable')]),
    ])
  )
  assertEquals(verdicts.get(A), 'unknown')
  assertEquals(verdicts.get(B), 'unknown')
})

test('one answer in either direction keeps a server ok', () => {
  const verdicts = probeVerdicts(
    report([server(A, [peer(B, 'not_reachable')]), server(B, [peer(A, 'reachable')])])
  )
  assertEquals(verdicts.get(A), 'ok')
  assertEquals(verdicts.get(B), 'ok')
})

test('the first good round records that the network has worked, and later good rounds write nothing', () => {
  const first = nextProbeMarker(undefined, 'ok', NOW)
  assertEquals(first, {
    marker: { failures: 0, okStreak: 0, firstOkAt: NOW },
    write: true,
    change: 'none',
  })
  const again = nextProbeMarker(first.marker ?? undefined, 'ok', NOW)
  assertEquals(again.write, false)
})

test('a network that never answered is never marked down', () => {
  assertEquals(nextProbeMarker(undefined, 'fail', NOW).write, false)
  assertEquals(nextProbeMarker({ failures: 0, okStreak: 0 }, 'fail', NOW).write, false)
})

test('the mark appears only after the failures in a row, and routing is told once', () => {
  let marker: IpPinUnreachableMetadata | undefined = { failures: 0, okStreak: 0, firstOkAt: NOW }
  const changes: string[] = []
  for (let round = 0; round < PROBE_FAILURES_TO_MARK_DOWN; round += 1) {
    const step = nextProbeMarker(marker, 'fail', `2026-10-23T18:0${round}:00.000Z`)
    marker = step.marker ?? undefined
    changes.push(step.change)
  }
  assertEquals(changes, ['none', 'none', 'down'])
  assertEquals(marker?.downSince, '2026-10-23T18:02:00.000Z')
  // Further failures change nothing.
  assertEquals(nextProbeMarker(marker, 'fail', NOW).write, false)
})

test('a good round in between resets the failure count', () => {
  const failed = nextProbeMarker({ failures: 2, okStreak: 0, firstOkAt: NOW }, 'ok', NOW)
  assertEquals(failed.marker, { failures: 0, okStreak: 0, firstOkAt: NOW })
  assertEquals(failed.change, 'none')
})

test('the mark goes after enough good rounds in a row', () => {
  const down: IpPinUnreachableMetadata = {
    failures: 3,
    okStreak: 0,
    firstOkAt: NOW,
    downSince: NOW,
  }
  const steps: string[] = []
  let marker: IpPinUnreachableMetadata | undefined = down
  for (let round = 0; round < PROBE_OKS_TO_CLEAR; round += 1) {
    const step = nextProbeMarker(marker, 'ok', NOW)
    marker = step.marker ?? undefined
    steps.push(step.change)
  }
  assertEquals(steps, ['none', 'up'])
  assertEquals(marker, { failures: 0, okStreak: 0, firstOkAt: NOW })
  // A failure between two good rounds starts the count again.
  const broken = nextProbeMarker({ ...down, okStreak: 1 }, 'fail', NOW)
  assertEquals(broken.marker?.okStreak, 0)
  assertEquals(broken.change, 'none')
})

test('unknown rounds change nothing', () => {
  const marker = { failures: 2, okStreak: 0, firstOkAt: NOW }
  assertEquals(nextProbeMarker(marker, 'unknown', NOW), { marker, write: false, change: 'none' })
})

test('the marker round-trips through ip metadata and keeps other keys', () => {
  const marker = { failures: 3, okStreak: 0, firstOkAt: NOW, downSince: NOW }
  const metadata = withProbeMarker({ repin: { at: NOW, from: '10.0.0.1' } }, marker)
  assertEquals(metadata.repin, { at: NOW, from: '10.0.0.1' })
  assertEquals(probeMarkerOf(metadata), marker)
  assertEquals(pinProbedDown(metadata), true)
  assertEquals(pinProbedDown(withProbeMarker(metadata, null)), false)
  assertEquals(probeMarkerOf(null), undefined)
  assertEquals(parseUnreachableMarker({ failures: -1, okStreak: 'x' }), {
    failures: 0,
    okStreak: 0,
  })
})
