/**
 * The whole-host-loss decision rule (`ha-host-loss.ts`): pure, no database.
 */

import { assertEquals } from '@std/assert'
import { MANAGED_HA_BOOT_HOLD_FEATURE } from '../../lib/version-wire.ts'
import {
  DEFAULT_HOST_LOSS_WINDOW_MS,
  HOST_LOSS_ALERT_MESSAGES,
  HOST_LOSS_GIVE_UP_MS,
  HOST_LOSS_LAST_DECISION_MS,
  HOST_LOSS_MARK_LAG_MS,
  HOST_LOSS_PLANNED_GRACE_MS,
  type HostLossPreflightFacts,
  hostLossFailureStartMs,
  hostLossIncidentKey,
  hostLossPreflight,
  hostLossVerdict,
  MAX_HOST_LOSS_WINDOW_MS,
  MIN_HOST_LOSS_WINDOW_MS,
  readPeer,
  resolveHostLossWindowMs,
} from './ha-host-loss.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const WINDOW = DEFAULT_HOST_LOSS_WINDOW_MS

function facts(overrides: Partial<HostLossPreflightFacts> = {}): HostLossPreflightFacts {
  return {
    nowMs: NOW,
    offlineSinceMs: NOW - WINDOW - 1_000,
    windowMs: WINDOW,
    engine: 'postgres',
    primaryDaemonFeatures: [MANAGED_HA_BOOT_HOLD_FEATURE],
    plannedReboot: false,
    orgServers: 2,
    orgServersOffline: 1,
    peerServerOffline: false,
    ...overrides,
  }
}

test('inside the window nothing is decided: a blip that returns changes nothing', () => {
  assertEquals(hostLossPreflight(facts({ offlineSinceMs: NOW - 30_000 })), {
    action: 'wait',
    reason: 'inside_window',
  })
  // One millisecond short of the window is still waiting; the window itself decides.
  assertEquals(hostLossPreflight(facts({ offlineSinceMs: NOW - WINDOW + 1 })).action, 'wait')
  assertEquals(hostLossPreflight(facts({ offlineSinceMs: NOW - WINDOW })).action, 'probe')
})

test('a clean case goes on to ask the other members', () => {
  assertEquals(hostLossPreflight(facts()), { action: 'probe' })
})

test('a planned reboot or update waits, but never past the last moment a promotion can be decided', () => {
  const offlineSinceMs = NOW - 5 * 60_000
  assertEquals(hostLossPreflight(facts({ offlineSinceMs, plannedReboot: true })), {
    action: 'wait',
    reason: 'planned_reboot',
  })
  assertEquals(
    hostLossPreflight(
      facts({ offlineSinceMs: NOW - HOST_LOSS_PLANNED_GRACE_MS - 1, plannedReboot: true })
    ),
    { action: 'alert', code: 'too_late' }
  )
})

test('an offline mark that cannot be read is never acted on', () => {
  assertEquals(hostLossPreflight(facts({ offlineSinceMs: Number.NaN })), { action: 'ignore' })
  assertEquals(hostLossPreflight(facts({ nowMs: Number.NaN })), { action: 'ignore' })
})

test('too late to tie the replicas to the failure: alert only, never a late promotion', () => {
  // The cap is the fresh-standby gate's 10 minute span counted from the earliest death.
  assertEquals(HOST_LOSS_LAST_DECISION_MS, 450_000)
  assertEquals(
    hostLossPreflight(facts({ offlineSinceMs: NOW - HOST_LOSS_LAST_DECISION_MS })).action,
    'probe'
  )
  assertEquals(hostLossPreflight(facts({ offlineSinceMs: NOW - HOST_LOSS_LAST_DECISION_MS - 1 })), {
    action: 'alert',
    code: 'too_late',
  })
  // A planned reboot cannot push a decision past the cap either.
  assertEquals(
    hostLossPreflight(
      facts({ offlineSinceMs: NOW - HOST_LOSS_LAST_DECISION_MS - 1, plannedReboot: true })
    ),
    { action: 'alert', code: 'too_late' }
  )
  // The widest window still leaves time to decide.
  assertEquals(MAX_HOST_LOSS_WINDOW_MS < HOST_LOSS_LAST_DECISION_MS, true)
})

test('a host that has been gone for half an hour is not an incident this path works on', () => {
  assertEquals(hostLossPreflight(facts({ offlineSinceMs: NOW - HOST_LOSS_GIVE_UP_MS - 1 })), {
    action: 'ignore',
  })
})

test('more than half of the organization offline is a fleet outage, not one lost host', () => {
  assertEquals(hostLossPreflight(facts({ orgServers: 3, orgServersOffline: 2 })), {
    action: 'alert',
    code: 'fleet_outage',
  })
  // Exactly half (the pair test setup: 1 of 2) still counts as one lost host.
  assertEquals(hostLossPreflight(facts({ orgServers: 4, orgServersOffline: 2 })).action, 'probe')
  assertEquals(hostLossPreflight(facts({ orgServers: 2, orgServersOffline: 1 })).action, 'probe')
})

test('PostgreSQL, MySQL and MariaDB are probed on host loss; other engines alert only', () => {
  for (const engine of ['postgres', 'mysql', 'mariadb']) {
    assertEquals(hostLossPreflight(facts({ engine })), { action: 'probe' })
  }
  assertEquals(hostLossPreflight(facts({ engine: 'redis' })), {
    action: 'alert',
    code: 'engine_unsupported',
  })
})

test('a daemon that cannot hold a returning primary back is never trusted', () => {
  assertEquals(hostLossPreflight(facts({ primaryDaemonFeatures: [] })), {
    action: 'alert',
    code: 'daemon_too_old',
  })
  assertEquals(
    hostLossPreflight(facts({ primaryDaemonFeatures: ['managed-health-v1'] })).action,
    'alert'
  )
})

test('another member whose server is also offline cannot corroborate', () => {
  assertEquals(hostLossPreflight(facts({ peerServerOffline: true })), {
    action: 'alert',
    code: 'not_corroborated',
  })
})

test('the first matching refusal wins, in the documented order', () => {
  const everythingWrong = facts({
    engine: 'redis',
    primaryDaemonFeatures: [],
    orgServers: 3,
    orgServersOffline: 3,
    peerServerOffline: true,
  })
  assertEquals(hostLossPreflight(everythingWrong), { action: 'alert', code: 'fleet_outage' })
  assertEquals(hostLossPreflight({ ...everythingWrong, orgServersOffline: 1 }), {
    action: 'alert',
    code: 'engine_unsupported',
  })
})

test('a reading says "receiving" only for a streaming member; non-streaming requires time proof', () => {
  const at = new Date(NOW).toISOString()
  const window = 120_000 // 2 min

  // Streaming: always veto (still receiving)
  assertEquals(readPeer({ state: 'streaming', observedAt: at }, window), 'still_receiving')

  // Non-streaming without lastStreaming proof: cannot corroborate yet
  assertEquals(readPeer({ state: 'stopped', observedAt: at }, window), 'no_answer')
  assertEquals(readPeer({ state: 'starting', observedAt: at }, window), 'no_answer')

  // Non-streaming with lastStreaming.ageMs > window: corroborates
  assertEquals(
    readPeer({ state: 'stopped', observedAt: at, lastStreaming: { at, ageMs: 150_000 } }, window),
    'not_receiving'
  )

  // Non-streaming with lastStreaming.ageMs <= window: cannot corroborate yet
  assertEquals(
    readPeer({ state: 'starting', observedAt: at, lastStreaming: { at, ageMs: 90_000 } }, window),
    'no_answer'
  )

  // No answer cases
  assertEquals(readPeer(null, window), 'no_answer')
  assertEquals(readPeer({ state: '', observedAt: at }, window), 'no_answer')
})

test('promotion needs every other member to say it is not receiving; one that hears the primary vetoes', () => {
  assertEquals(hostLossVerdict(['not_receiving']), { action: 'promote' })
  assertEquals(hostLossVerdict(['not_receiving', 'not_receiving']), { action: 'promote' })
  assertEquals(hostLossVerdict(['not_receiving', 'still_receiving']), {
    action: 'alert',
    code: 'peer_streaming',
  })
  assertEquals(hostLossVerdict(['still_receiving', 'no_answer']), {
    action: 'alert',
    code: 'peer_streaming',
  })
  assertEquals(hostLossVerdict(['not_receiving', 'no_answer']), {
    action: 'alert',
    code: 'not_corroborated',
  })
  assertEquals(hostLossVerdict([]), { action: 'alert', code: 'not_corroborated' })
})

test('the window is configurable but clamped, and a bad value falls back to the default', () => {
  assertEquals(resolveHostLossWindowMs({}), DEFAULT_HOST_LOSS_WINDOW_MS)
  assertEquals(resolveHostLossWindowMs(undefined), DEFAULT_HOST_LOSS_WINDOW_MS)
  assertEquals(resolveHostLossWindowMs({ TURBOPANEL_HOST_LOSS_WINDOW_SECONDS: '200' }), 200_000)
  assertEquals(
    resolveHostLossWindowMs({ TURBOPANEL_HOST_LOSS_WINDOW_SECONDS: '900' }),
    MAX_HOST_LOSS_WINDOW_MS
  )
  assertEquals(
    resolveHostLossWindowMs({ TURBOPANEL_HOST_LOSS_WINDOW_SECONDS: '5' }),
    MIN_HOST_LOSS_WINDOW_MS
  )
  assertEquals(
    resolveHostLossWindowMs({ TURBOPANEL_HOST_LOSS_WINDOW_SECONDS: '99999' }),
    MAX_HOST_LOSS_WINDOW_MS
  )
  for (const bad of ['', 'soon', '-60', '1e3', '12.5', '123456']) {
    assertEquals(
      resolveHostLossWindowMs({ TURBOPANEL_HOST_LOSS_WINDOW_SECONDS: bad }),
      DEFAULT_HOST_LOSS_WINDOW_MS,
      bad
    )
  }
})

test('an incident is one server silent since one offline mark; the failure start trails the mark', () => {
  assertEquals(
    hostLossIncidentKey('srv', '2026-10-06T12:00:00.000Z'),
    'srv@2026-10-06T12:00:00.000Z'
  )
  assertEquals(hostLossFailureStartMs(NOW), NOW - HOST_LOSS_MARK_LAG_MS)
})

test('every refusal has a plain-words message that names what to do', () => {
  for (const [code, message] of Object.entries(HOST_LOSS_ALERT_MESSAGES)) {
    assertEquals(message.length > 40, true, code)
    assertEquals(/principal|tenant/i.test(message), false, code)
  }
})
