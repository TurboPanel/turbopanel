import { assertEquals } from '@std/assert'
import { connectorUpdateNotice, nextTunnelStatus, portalErrorOf, portalStateOf } from './status.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const base = {
  tunnelId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  version: '2026.5.2',
  slot: 'a' as const,
}

test('a connector state maps to the portal state it is shown as', () => {
  assertEquals(portalStateOf('connected'), 'connected')
  assertEquals(portalStateOf('connecting'), 'unknown')
  assertEquals(portalStateOf('failed'), 'error')
  assertEquals(portalStateOf('stopped'), 'down')
  assertEquals(portalStateOf('not-installed'), 'down')
})

test('a failed service or an update that stopped carries a plain reason', () => {
  assertEquals(portalErrorOf({ ...base, status: 'connected' }), null)
  assertEquals(
    portalErrorOf({ ...base, status: 'failed' }),
    'The connector service stopped with an error.'
  )
  assertEquals(
    portalErrorOf({
      ...base,
      status: 'connected',
      lastUpdate: {
        outcome: 'rolled-back',
        at: '2026-10-28T12:00:00Z',
        reason: 'it did not connect in time',
      },
    }),
    'The last connector update did not finish: it did not connect in time'
  )
  assertEquals(
    portalErrorOf({
      ...base,
      status: 'connected',
      lastUpdate: { outcome: 'updated', at: '2026-10-28T12:00:00Z' },
    }),
    null
  )
})

test('an update is pending only when the running version differs from the one the daemon moves to', () => {
  const meta = (pinned: string, reason?: string) => ({
    connector: {
      pinnedVersion: pinned,
      slot: 'a',
      ...(reason
        ? { lastUpdate: { outcome: 'rolled-back', at: '2026-10-28T12:00:00Z', reason } }
        : {}),
    },
  })
  assertEquals(connectorUpdateNotice('2026.5.2', meta('2026.5.2')).pending, false)
  const pending = connectorUpdateNotice('2026.5.0', meta('2026.5.2', 'it did not connect'))
  assertEquals(pending, {
    pending: true,
    runningVersion: '2026.5.0',
    pinnedVersion: '2026.5.2',
    reason: 'it did not connect',
  })
  // Nothing reported yet: no notice, and nothing breaks on odd metadata.
  assertEquals(connectorUpdateNotice(null, null).pending, false)
  assertEquals(connectorUpdateNotice('2026.5.2', []).pending, false)
  assertEquals(connectorUpdateNotice('2026.5.2', { connector: 7 }).pending, false)
})

test('a tunnel is active once a connector is connected, attention when none is and one is not, and keeps removing', () => {
  assertEquals(nextTunnelStatus('pending', ['unknown'], 'connected'), 'active')
  assertEquals(nextTunnelStatus('pending', ['connected', 'down'], 'down'), 'active')
  assertEquals(nextTunnelStatus('active', ['down', 'unknown'], 'down'), 'attention')
  assertEquals(nextTunnelStatus('active', ['unknown'], 'unknown'), 'active')
  assertEquals(nextTunnelStatus('pending', ['unknown'], 'unknown'), 'pending')
  assertEquals(nextTunnelStatus('attention', ['connected'], 'connected'), 'active')
  assertEquals(nextTunnelStatus('removing', ['connected'], 'connected'), 'removing')
})

test('an all-servers tunnel has no portal rows, so one server going down only moves it off pending', () => {
  assertEquals(nextTunnelStatus('pending', [], 'connected'), 'active')
  assertEquals(nextTunnelStatus('pending', [], 'error'), 'attention')
  assertEquals(nextTunnelStatus('active', [], 'down'), 'active')
})
