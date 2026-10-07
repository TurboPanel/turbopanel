/**
 * The whole-host-loss sweep (`ha-host-loss-sweep.ts`): what each situation
 * does, with every database read and write behind a seam.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { ManagedReplicationHealth } from '../../contracts/commands/schemas.ts'
import { MANAGED_HA_BOOT_HOLD_FEATURE } from '../../lib/version-wire.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { DEFAULT_HOST_LOSS_WINDOW_MS, HOST_LOSS_MARK_LAG_MS } from './ha-host-loss.ts'
import {
  type HostLossCandidate,
  type HostLossLoaders,
  type HostLossOutcome,
  type HostLossServerFacts,
  runHostLossSweep,
} from './ha-host-loss-sweep.ts'
import type { FreshStandbyProbe } from './ha-fresh-standby.ts'
import type { ManagedMemberRow } from './members.ts'
import { managedMemberRow } from '../../test-fixtures/managed-member.ts'
import type { RecoveryRecord } from './recovery.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-10-06T12:00:00.000Z')
const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const MANAGED_ID_2 = '00000000-0000-4000-8000-000000000002'
const MEM_PRIMARY = '00000000-0000-4000-8000-000000000020'
const MEM_REPLICA = '00000000-0000-4000-8000-000000000021'
const MEM_THIRD = '00000000-0000-4000-8000-000000000022'
const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const SERVER_C = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const ORG = '00000000-0000-4000-8000-0000000000aa'
const NOW_ISO = new Date(NOW).toISOString()

/** The primary's server went offline 3 minutes ago: past the 2-minute window. */
const OFFLINE_SINCE_MS = NOW - 180_000
const OFFLINE_SINCE = new Date(OFFLINE_SINCE_MS).toISOString()
const INCIDENT = `${SERVER_A}@${OFFLINE_SINCE}`

const member = managedMemberRow

function replicaMember(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return member({
    id: MEM_REPLICA,
    serverId: SERVER_B,
    role: 'replica',
    replicaClass: 'failover',
    ordinal: 2,
    ...overrides,
  })
}

function candidate(overrides: Partial<HostLossCandidate> = {}): HostLossCandidate {
  return {
    managedId: MANAGED_ID,
    engine: 'postgres',
    primaryMemberId: MEM_PRIMARY,
    primaryServerId: SERVER_A,
    organizationId: ORG,
    offlineSince: OFFLINE_SINCE,
    ...overrides,
  }
}

const NOT_RECEIVING: ManagedReplicationHealth = {
  state: 'stopped',
  observedAt: NOW_ISO,
  lastStreaming: { at: new Date(NOW - 600_000).toISOString(), ageMs: 600_000 },
}
const STILL_RECEIVING: ManagedReplicationHealth = { state: 'streaming', observedAt: NOW_ISO }

type World = {
  candidates?: HostLossCandidate[]
  members?: ManagedMemberRow[]
  connected?: Record<string, boolean>
  facts?: Partial<HostLossServerFacts>
  org?: { total: number; offline: number }
  inFlight?: RecoveryRecord | null
  answers?: Record<string, ManagedReplicationHealth | null>
}

type Calls = {
  probes: Array<Parameters<FreshStandbyProbe>[0]>
  alerts: Array<{ code: string; incident: string; evidence: string }>
  failovers: Array<Record<string, unknown>>
}

async function sweep(
  world: World,
  options: { autoFailover?: 'on' | 'off'; throwOn?: string } = {}
): Promise<{ outcomes: HostLossOutcome[]; calls: Calls }> {
  const calls: Calls = { probes: [], alerts: [], failovers: [] }
  const members = world.members ?? [member(), replicaMember()]
  const loaders: HostLossLoaders = {
    listOfflinePrimaries: () => Promise.resolve(world.candidates ?? [candidate()]),
    listMembers: (_db, managedId) => {
      if (managedId === options.throwOn) return Promise.reject(new TypeError('database blip'))
      return Promise.resolve(members.map((row) => ({ ...row, managedId })))
    },
    connectedServers: (_db, ids) =>
      Promise.resolve(new Map(ids.map((id) => [id, world.connected?.[id] ?? true]))),
    serverFacts: () =>
      Promise.resolve({
        features: [MANAGED_HA_BOOT_HOLD_FEATURE],
        updateInFlight: false,
        rebootRecently: false,
        ...world.facts,
      }),
    organizationServers: () => Promise.resolve(world.org ?? { total: 2, offline: 1 }),
    inFlightRecovery: () => Promise.resolve(world.inFlight ?? null),
  }
  const probeStandby: FreshStandbyProbe = (target) => {
    calls.probes.push(target)
    return Promise.resolve(
      world.answers && target.memberId in world.answers
        ? (world.answers[target.memberId] ?? null)
        : NOT_RECEIVING
    )
  }
  const queue: CommandQueue = { enqueue: () => Promise.resolve() }
  const outcomes = await runHostLossSweep({} as Db, {
    commandQueue: queue,
    autoFailover: options.autoFailover ?? 'on',
    probeStandby,
    windowMs: DEFAULT_HOST_LOSS_WINDOW_MS,
    nowMs: () => NOW,
    loaders,
    recordAlert: (_db, params) => {
      calls.alerts.push({
        code: params.code,
        incident: params.incident,
        evidence: params.evidence,
      })
      return Promise.resolve({} as RecoveryRecord)
    },
    beginFailover: (params) => {
      calls.failovers.push(params as unknown as Record<string, unknown>)
      return Promise.resolve(null)
    },
  })
  return { outcomes, calls }
}

test('host vanishes and the replica confirms: the failover starts, anchored on the offline mark', async () => {
  const { outcomes, calls } = await sweep({})
  assertEquals(outcomes, [{ managedId: MANAGED_ID, result: 'failover' }])
  assertEquals(calls.alerts, [])
  assertEquals(calls.failovers.length, 1)
  const begin = calls.failovers[0]!
  assertEquals(begin.hostLossIncident, INCIDENT)
  assertEquals(begin.detector, 'host-loss')
  assertEquals(begin.sourceMemberId, MEM_PRIMARY)
  assertEquals(begin.autoFailover, 'on')
  // The earliest the host can have died: the offline mark minus the sweep's lag.
  assertEquals(begin.failureStartedAtMs, OFFLINE_SINCE_MS - HOST_LOSS_MARK_LAG_MS)
  // Every other member was asked, and the dead primary never was.
  assertEquals(
    calls.probes.map((probe) => probe.memberId),
    [MEM_REPLICA]
  )
})

test('the per-environment switch is passed through unchanged (off = the failover path refuses and alerts)', async () => {
  const { calls } = await sweep({}, { autoFailover: 'off' })
  assertEquals(calls.failovers[0]?.autoFailover, 'off')
})

test('a replica that still hears the primary vetoes: alert only, no failover', async () => {
  const { outcomes, calls } = await sweep({ answers: { [MEM_REPLICA]: STILL_RECEIVING } })
  assertEquals(outcomes, [{ managedId: MANAGED_ID, result: 'alert', code: 'peer_streaming' }])
  assertEquals(calls.failovers, [])
  assertEquals(calls.alerts[0]?.incident, INCIDENT)
})

test('no corroboration (the replica does not answer): alert only, no failover', async () => {
  const { outcomes, calls } = await sweep({ answers: { [MEM_REPLICA]: null } })
  assertEquals(outcomes, [{ managedId: MANAGED_ID, result: 'alert', code: 'not_corroborated' }])
  assertEquals(calls.failovers, [])
})

test('with three members every other member must confirm', async () => {
  const members = [
    member(),
    replicaMember(),
    replicaMember({ id: MEM_THIRD, serverId: SERVER_C, ordinal: 3 }),
  ]
  const both = await sweep({ members, org: { total: 3, offline: 1 } })
  assertEquals(both.outcomes[0]?.result, 'failover')
  assertEquals(both.calls.probes.map((probe) => probe.memberId).sort(), [MEM_REPLICA, MEM_THIRD])

  const oneHearsIt = await sweep({
    members,
    org: { total: 3, offline: 1 },
    answers: { [MEM_THIRD]: STILL_RECEIVING },
  })
  assertEquals(oneHearsIt.outcomes[0], {
    managedId: MANAGED_ID,
    result: 'alert',
    code: 'peer_streaming',
  })
  assertEquals(oneHearsIt.calls.failovers, [])
})

test('another member whose server is also offline: alert only, and nobody is probed', async () => {
  const { outcomes, calls } = await sweep({ connected: { [SERVER_B]: false } })
  assertEquals(outcomes[0], { managedId: MANAGED_ID, result: 'alert', code: 'not_corroborated' })
  assertEquals(calls.probes, [])
  assertEquals(calls.failovers, [])
})

test('a blip: the server is offline for less than the window, so nothing happens at all', async () => {
  const { outcomes, calls } = await sweep({
    candidates: [candidate({ offlineSince: new Date(NOW - 60_000).toISOString() })],
  })
  assertEquals(outcomes, [{ managedId: MANAGED_ID, result: 'wait' }])
  assertEquals(calls.probes, [])
  assertEquals(calls.alerts, [])
  assertEquals(calls.failovers, [])
})

test('the host returned before the window: it is no longer a candidate and nothing happens', async () => {
  const { outcomes, calls } = await sweep({ candidates: [] })
  assertEquals(outcomes, [])
  assertEquals(calls.probes.length + calls.alerts.length + calls.failovers.length, 0)
})

test('MySQL and MariaDB alert only: no probe, no failover', async () => {
  for (const engine of ['mysql', 'mariadb']) {
    const { outcomes, calls } = await sweep({ candidates: [candidate({ engine })] })
    assertEquals(outcomes[0], {
      managedId: MANAGED_ID,
      result: 'alert',
      code: 'engine_unsupported',
    })
    assertEquals(calls.probes.length + calls.failovers.length, 0)
  }
})

test('a daemon without the boot hold: alert only', async () => {
  const { outcomes, calls } = await sweep({ facts: { features: ['managed-health-v1'] } })
  assertEquals(outcomes[0], { managedId: MANAGED_ID, result: 'alert', code: 'daemon_too_old' })
  assertEquals(calls.failovers, [])
})

test('an operator reboot or a daemon update in progress waits', async () => {
  for (const facts of [{ rebootRecently: true }, { updateInFlight: true }]) {
    const { outcomes, calls } = await sweep({
      facts,
      candidates: [candidate({ offlineSince: new Date(NOW - 300_000).toISOString() })],
    })
    assertEquals(outcomes, [{ managedId: MANAGED_ID, result: 'wait' }])
    assertEquals(calls.failovers.length + calls.alerts.length, 0)
  }
})

test('most of the fleet offline is an outage, not one lost host: alert only', async () => {
  const { outcomes, calls } = await sweep({ org: { total: 4, offline: 3 } })
  assertEquals(outcomes[0], { managedId: MANAGED_ID, result: 'alert', code: 'fleet_outage' })
  assertEquals(calls.failovers, [])
})

test('past the last moment a promotion can be decided it is an alert, never a late failover', async () => {
  const { outcomes, calls } = await sweep({
    candidates: [candidate({ offlineSince: new Date(NOW - 460_000).toISOString() })],
  })
  assertEquals(outcomes[0], { managedId: MANAGED_ID, result: 'alert', code: 'too_late' })
  assertEquals(calls.probes.length + calls.failovers.length, 0)
})

test('a recovery already in flight is left alone', async () => {
  const { outcomes, calls } = await sweep({ inFlight: { id: 'rec' } as RecoveryRecord })
  assertEquals(outcomes, [{ managedId: MANAGED_ID, result: 'busy' }])
  assertEquals(calls.probes.length + calls.failovers.length, 0)
})

test('a cluster whose roles changed under the sweep, or with a single member, is ignored', async () => {
  const flipped = await sweep({
    members: [member({ role: 'replica' }), replicaMember({ role: 'primary' })],
  })
  assertEquals(flipped.outcomes, [{ managedId: MANAGED_ID, result: 'ignore' }])
  const single = await sweep({ members: [member()] })
  assertEquals(single.outcomes, [{ managedId: MANAGED_ID, result: 'ignore' }])
})

test('a host offline for over half an hour is no longer worked on', async () => {
  const { outcomes } = await sweep({
    candidates: [candidate({ offlineSince: new Date(NOW - 2 * 3_600_000).toISOString() })],
  })
  assertEquals(outcomes, [{ managedId: MANAGED_ID, result: 'ignore' }])
})

test('one cluster failing never stops the others', async () => {
  const { outcomes, calls } = await sweep(
    {
      candidates: [candidate({ managedId: MANAGED_ID_2 }), candidate()],
    },
    { throwOn: MANAGED_ID_2 }
  )
  assertEquals(outcomes, [
    { managedId: MANAGED_ID_2, result: 'error' },
    { managedId: MANAGED_ID, result: 'failover' },
  ])
  assertEquals(calls.failovers.length, 1)
})

test('a failing candidate listing is survived and reports nothing', async () => {
  const outcomes = await runHostLossSweep({} as Db, {
    commandQueue: null,
    autoFailover: 'on',
    probeStandby: () => Promise.resolve(null),
    windowMs: DEFAULT_HOST_LOSS_WINDOW_MS,
    loaders: { listOfflinePrimaries: () => Promise.reject(new TypeError('down')) },
  })
  assertEquals(outcomes, [])
})
