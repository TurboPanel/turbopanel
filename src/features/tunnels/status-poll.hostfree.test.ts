import { assertEquals } from '@std/assert'
import { daemonCanReportTunnelStatus } from './daemon-gate.ts'
import {
  readAskedState,
  statusGapMs,
  TUNNEL_STATUS_NEW_PORTAL_GAP_MS,
  TUNNEL_STATUS_POLL_GAP_MS,
  TUNNEL_STATUS_STALE_MS,
} from './status-poll.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('only a daemon that advertises tunnel-status-v1 is asked', () => {
  assertEquals(daemonCanReportTunnelStatus(['tunnel-status-v1']), true)
  assertEquals(daemonCanReportTunnelStatus(['tunnel-forwarding-v1']), false)
  assertEquals(daemonCanReportTunnelStatus(undefined), false)
})

test('the last question is read back from the server metadata, and odd metadata reads as none', () => {
  const asked = { commandId: 'c1', sentAt: '2026-10-28T12:00:00.000Z' }
  assertEquals(readAskedState({ tunnelStatus: asked }), asked)
  assertEquals(
    readAskedState({ tunnelStatus: { ...asked, recordedAt: '2026-10-28T12:01:00.000Z' } }),
    { ...asked, recordedAt: '2026-10-28T12:01:00.000Z' }
  )
  assertEquals(readAskedState(null), null)
  assertEquals(readAskedState({ tunnelStatus: { commandId: 5 } }), null)
  assertEquals(readAskedState({}), null)
})

test('the gap to the next question: short for an unheard new connector, steady otherwise', () => {
  assertEquals(statusGapMs(true, true), TUNNEL_STATUS_NEW_PORTAL_GAP_MS)
  assertEquals(statusGapMs(true, false), TUNNEL_STATUS_POLL_GAP_MS)
  // An unanswered question always waits out its own life.
  assertEquals(statusGapMs(false, true), TUNNEL_STATUS_STALE_MS)
  assertEquals(statusGapMs(false, false), TUNNEL_STATUS_STALE_MS)
  // The steady gap is not raised or lowered by this.
  assertEquals(TUNNEL_STATUS_POLL_GAP_MS, 10 * 60 * 1000)
})
