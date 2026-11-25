import { assertEquals } from '@std/assert'
import { type ManagedMemberRow, serializeManagedMemberForDisplay } from './members.ts'
import {
  ageReplicationHealth,
  REPLICA_DISPLAY_REFRESH_MS,
  REPLICA_DISPLAY_STALE_MS,
} from './replica-freshness.ts'

/** Jest/Mocha-shaped alias so Sonar sees the tests (see ha-recovery.hostfree.test.ts). */
const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-10-06T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString()

test('a reading inside the freshness window is shown as it is', () => {
  const health = { state: 'streaming', observedAt: iso(-30_000), lagBytes: 0 }
  assertEquals(ageReplicationHealth(health, NOW_MS), health)
})

test('a streaming reading five minutes old is shown as unknown, with what it was and its age', () => {
  const aged = ageReplicationHealth(
    {
      state: 'streaming',
      observedAt: iso(-300_000),
    },
    NOW_MS
  )
  assertEquals(aged.state, 'unknown')
  assertEquals(aged.stale, true)
  assertEquals(aged.lastState, 'streaming')
  assertEquals(aged.ageSeconds, 300)
})

test('a catching-up reading ages the same way', () => {
  const aged = ageReplicationHealth(
    {
      state: 'catching_up',
      observedAt: iso(-121_000),
    },
    NOW_MS
  )
  assertEquals(aged.state, 'unknown')
  assertEquals(aged.lastState, 'catching_up')
})

test('an old negative reading stays negative: it is never made vaguer', () => {
  const health = { state: 'not_streaming', observedAt: iso(-3_600_000) }
  assertEquals(ageReplicationHealth(health, NOW_MS), health)
})

test('an unreadable or far-future timestamp cannot keep a replica looking healthy', () => {
  const unreadable = ageReplicationHealth(
    {
      state: 'streaming',
      observedAt: 'not a date',
    },
    NOW_MS
  )
  assertEquals(unreadable.state, 'unknown')
  assertEquals(unreadable.ageSeconds, undefined)
  const future = ageReplicationHealth(
    {
      state: 'streaming',
      observedAt: iso(86_400_000),
    },
    NOW_MS
  )
  assertEquals(future.state, 'unknown')
})

test('the panel view ages a replica but leaves the primary alone', () => {
  const row = (role: string, observedAt: string): ManagedMemberRow =>
    ({
      id: `${role}-1`,
      managedId: 'managed-1',
      serverId: 'server-1',
      role,
      replicaClass: role === 'replica' ? 'failover' : null,
      readEligible: true,
      ordinal: role === 'replica' ? 2 : 1,
      replicationTransport: null,
      privatePort: null,
      status: 'ready',
      metadata: { replication: { state: 'streaming', observedAt } },
      options: null,
      createdAt: iso(0),
      updatedAt: iso(0),
    }) as ManagedMemberRow
  const old = iso(-600_000)
  assertEquals(
    serializeManagedMemberForDisplay(row('replica', old), null, NOW_MS).replication?.state,
    'unknown'
  )
  assertEquals(
    serializeManagedMemberForDisplay(row('primary', old), null, NOW_MS).replication?.state,
    'streaming'
  )
})

test('a pushed reading stays fresh across its five minute refresh, a probe reading does not', () => {
  assertEquals(REPLICA_DISPLAY_STALE_MS > REPLICA_DISPLAY_REFRESH_MS, true)
  const row = (metadata: Record<string, unknown>): ManagedMemberRow =>
    ({
      id: 'replica-1',
      managedId: 'managed-1',
      serverId: 'server-1',
      role: 'replica',
      replicaClass: 'failover',
      readEligible: true,
      ordinal: 2,
      replicationTransport: null,
      privatePort: null,
      status: 'ready',
      metadata,
      options: null,
      createdAt: iso(0),
      updatedAt: iso(0),
    }) as ManagedMemberRow
  const measuredOld = { state: 'streaming', observedAt: iso(-3_600_000) }
  const pushed = (ageMs: number) => ({
    replication: measuredOld,
    replicationDisplay: { state: 'streaming', observedAt: iso(-ageMs) },
  })
  const stateOf = (metadata: Record<string, unknown>) =>
    serializeManagedMemberForDisplay(row(metadata), null, NOW_MS).replication?.state
  // Just before the next refresh would land: still shown as streaming.
  assertEquals(stateOf(pushed(REPLICA_DISPLAY_REFRESH_MS + 30_000)), 'streaming')
  // Nothing has refreshed it for twice the interval: unknown.
  assertEquals(stateOf(pushed(REPLICA_DISPLAY_STALE_MS + 1000)), 'unknown')
  // A probe reading of the same age keeps the 120 s window.
  assertEquals(
    stateOf({ replication: { state: 'streaming', observedAt: iso(-REPLICA_DISPLAY_REFRESH_MS) } }),
    'unknown'
  )
})
