import { assertEquals } from '@std/assert'
import {
  FABRIC_HANDSHAKE_HEALTHY_MS,
  FABRIC_OBSERVATION_MAX_AGE_MS,
  pairTunnelHealth,
} from './peer-health.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const OTHER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
const AT_MS = Date.parse('2026-10-30T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function observedWith(handshakeMs: number | undefined, atMs = AT_MS) {
  return {
    at: iso(atMs),
    peers: [
      handshakeMs === undefined
        ? { publicKey: OTHER }
        : { publicKey: OTHER, lastHandshakeAt: iso(handshakeMs) },
    ],
  }
}

test('pairTunnelHealth is healthy within the handshake window of the reading', () => {
  const observed = observedWith(AT_MS - FABRIC_HANDSHAKE_HEALTHY_MS)
  assertEquals(pairTunnelHealth(observed, OTHER, AT_MS + 60_000), 'healthy')
})

test('pairTunnelHealth is down on an old, missing or absent handshake', () => {
  const now = AT_MS + 1_000
  assertEquals(
    pairTunnelHealth(observedWith(AT_MS - FABRIC_HANDSHAKE_HEALTHY_MS - 1), OTHER, now),
    'down'
  )
  assertEquals(pairTunnelHealth(observedWith(undefined), OTHER, now), 'down')
  assertEquals(pairTunnelHealth({ at: iso(AT_MS), peers: [] }, OTHER, now), 'down')
})

test('pairTunnelHealth is unknown without a fresh reading or a key', () => {
  const observed = observedWith(AT_MS)
  assertEquals(pairTunnelHealth(undefined, OTHER, AT_MS), 'unknown')
  assertEquals(pairTunnelHealth(observed, null, AT_MS), 'unknown')
  assertEquals(
    pairTunnelHealth(observed, OTHER, AT_MS + FABRIC_OBSERVATION_MAX_AGE_MS + 1),
    'unknown'
  )
  assertEquals(pairTunnelHealth({ at: 'nope', peers: [] }, OTHER, AT_MS), 'unknown')
  // Exactly ten minutes old still counts.
  assertEquals(pairTunnelHealth(observed, OTHER, AT_MS + FABRIC_OBSERVATION_MAX_AGE_MS), 'healthy')
})
