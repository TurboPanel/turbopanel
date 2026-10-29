import { assertEquals } from '@std/assert'
import { daemonCanReportTunnelStatus } from './daemon-gate.ts'
import { readAskedState } from './status-poll.ts'

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
