import { assertEquals } from '@std/assert'
import {
  connectorsNeedingRepair,
  connectorUpdateNotice,
  nextTunnelStatus,
  peerDowngradeRepeats,
  peerHopStatusOf,
  peerLeafRemintDue,
  portalErrorOf,
  portalStateOf,
  toApiPeerHop,
} from './status.ts'

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

test('only asked connectors that are not running need a repair', () => {
  const other = '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'
  const third = '2c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f'
  const fourth = '3d4e5f6a-7b8c-4d9e-9fa0-2b3c4d5e6f70'
  const result = {
    pinnedVersion: '2026.5.2',
    connectors: [
      { ...base, status: 'stopped' as const },
      { ...base, tunnelId: other, status: 'connected' as const },
      { ...base, tunnelId: third, status: 'failed' as const },
      { ...base, tunnelId: 'instance', status: 'stopped' as const },
      { ...base, tunnelId: fourth, status: 'not-installed' as const },
    ],
  }
  // The control plane's own tunnel and ids it never asked for are not its to repair.
  assertEquals(connectorsNeedingRepair(result, [base.tunnelId, other]), [base.tunnelId])
  assertEquals(connectorsNeedingRepair(result, [third, base.tunnelId]), [base.tunnelId, third])
  assertEquals(connectorsNeedingRepair(result, [fourth, other]), [fourth])
  assertEquals(connectorsNeedingRepair(result, [other]), [])
  assertEquals(connectorsNeedingRepair(result, []), [])
  // Running or starting: nothing to repair.
  for (const status of ['connecting', 'connected'] as const) {
    assertEquals(
      connectorsNeedingRepair({ ...result, connectors: [{ ...base, status }] }, [base.tunnelId]),
      []
    )
  }
})

test('the reported peer hop mode is read back from server metadata, and a downgrade shows', () => {
  assertEquals(peerHopStatusOf(null), null)
  assertEquals(peerHopStatusOf({}), null)
  assertEquals(peerHopStatusOf({ tunnelPeerHop: { clientAuth: 'x' } }), null)
  assertEquals(peerHopStatusOf({ tunnelPeerHop: { clientAuth: 'require' } }), {
    clientAuth: 'require',
    downgraded: false,
  })
  assertEquals(peerHopStatusOf({ tunnelPeerHop: { clientAuth: 'verify', downgraded: true } }), {
    clientAuth: 'verify',
    downgraded: true,
  })
})

test('a downgrade asks for one new peer leaf per report, and a repeat is only logged', () => {
  const hop = (extra: object) => ({ tunnelPeerHop: { clientAuth: 'verify', ...extra } })
  assertEquals(peerLeafRemintDue(null), false)
  assertEquals(peerLeafRemintDue(hop({ downgraded: false })), false)
  assertEquals(peerLeafRemintDue(hop({ downgraded: true })), true)
  assertEquals(peerDowngradeRepeats(hop({ downgraded: true })), false)
  // After the re-mint was marked, the same report asks for nothing more.
  assertEquals(peerLeafRemintDue(hop({ downgraded: true, reminted: true })), false)
  assertEquals(peerDowngradeRepeats(hop({ downgraded: true, reminted: true })), true)
  // A mode that is no longer downgraded is neither.
  assertEquals(peerDowngradeRepeats(hop({ downgraded: false, reminted: true })), false)
})

test('the API shows the peer hop as a mode, a downgrade flag and the report time', () => {
  const none = { mode: 'none' as const, downgraded: false, reportedAt: null }
  assertEquals(toApiPeerHop(null), none)
  assertEquals(toApiPeerHop({ tunnelPeerHop: { clientAuth: 'bad' } }), none)
  assertEquals(
    toApiPeerHop({
      tunnelPeerHop: { clientAuth: 'verify', downgraded: true, reportedAt: '2026-11-17T10:00:00Z' },
    }),
    { mode: 'verify', downgraded: true, reportedAt: '2026-11-17T10:00:00Z' }
  )
  // A report stored before the time was kept has no time.
  assertEquals(toApiPeerHop({ tunnelPeerHop: { clientAuth: 'require' } }), {
    mode: 'require',
    downgraded: false,
    reportedAt: null,
  })
})
