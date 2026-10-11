import { assertEquals } from '@std/assert'
import { type ManagedMemberRow, serializeManagedMemberForDisplay } from './members.ts'
import { ageReplicationHealth } from './replica-freshness.ts'

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
