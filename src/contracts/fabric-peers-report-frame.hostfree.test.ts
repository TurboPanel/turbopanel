/**
 * `fabric-peers-report` frame shape (`validateDaemonInboundFrame`). Stamping
 * a well-formed report is `handleFabricPeersReport`'s job, covered in
 * src/features/fabric/peer-report.hostfree.test.ts.
 */

import { assert, assertEquals } from '@std/assert'
import {
  DAEMON_INBOUND_ALLOWED,
  MAX_DAEMON_WS_FABRIC_PEER_REPORT_PEERS,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from './cell-protocol.ts'
import type { DaemonMessage } from './cell-protocol.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

function peer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publicKey: KEY,
    lastHandshakeAt: '2026-10-30T11:59:30.000Z',
    transferRx: 10,
    transferTx: 20,
    endpoint: '203.0.113.7:51820',
    health: 'healthy',
    interface: 'eth0',
    ...overrides,
  }
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'fabric-peers-report',
    peers: [peer()],
    observedAt: '2026-10-30T12:00:00.000Z',
    at: '2026-10-30T12:00:01.000Z',
    ...overrides,
  }
}

function check(frame: Record<string, unknown>) {
  return validateDaemonInboundFrame(JSON.stringify(frame))
}

function reason(frame: Record<string, unknown>): string | null {
  const result = check(frame)
  return result.ok ? null : result.reason
}

test('fabric-peers-report is an allowed, fire-and-forget inbound type', () => {
  const allowed: ReadonlySet<string> = DAEMON_INBOUND_ALLOWED
  assert(allowed.has('fabric-peers-report'))
  const message = report() as unknown as DaemonMessage
  assertEquals(wireMessageToInboundEnvelope(message), null)
})

test('a well-formed report passes, with or without peers or optional fields', () => {
  assertEquals(reason(report()), null)
  assertEquals(reason(report({ peers: [] })), null)
  assertEquals(reason(report({ peers: [{ publicKey: KEY }] })), null)
})

test('unknown extra keys on the frame or a peer are ignored', () => {
  const result = check(report({ future: 1, peers: [peer({ latencyMs: 4 })] }))
  assertEquals(result.ok, true)
})

test('a health class this control plane does not know is ignored, not refused', () => {
  const result = check(report({ peers: [peer({ health: 'blocked' })] }))
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.ignored, true)
})

test('malformed frames are refused', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [report({ at: 'yesterday' }), 'invalid at timestamp'],
    [report({ observedAt: undefined }), 'invalid observedAt timestamp'],
    [report({ peers: 'x' }), 'invalid peers'],
    [report({ peers: ['x'] }), 'invalid peer'],
    [report({ peers: [peer({ publicKey: 'nope' })] }), 'invalid peer.publicKey'],
    [report({ peers: [peer({ lastHandshakeAt: 5 })] }), 'invalid peer.lastHandshakeAt'],
    [report({ peers: [peer({ transferRx: -1 })] }), 'invalid peer.transferRx'],
    [report({ peers: [peer({ transferTx: 1.5 })] }), 'invalid peer.transferTx'],
    [report({ peers: [peer({ endpoint: 'not an endpoint' })] }), 'invalid peer.endpoint'],
    [report({ peers: [peer({ interface: 'bad/name' })] }), 'invalid peer.interface'],
    [report({ peers: [peer({ health: 7 })] }), 'invalid peer.health'],
  ]
  for (const [frame, expected] of cases) {
    const result = check(frame)
    assertEquals(result.ok, false, expected)
    if (!result.ok) {
      assertEquals(result.reason, expected)
      assertEquals(result.ignored ?? false, false, expected)
    }
  }
})

test('more peers than the cap are refused', () => {
  const peers = Array.from({ length: MAX_DAEMON_WS_FABRIC_PEER_REPORT_PEERS + 1 }, () => peer())
  assertEquals(reason(report({ peers })), 'peers exceed max entries')
})
