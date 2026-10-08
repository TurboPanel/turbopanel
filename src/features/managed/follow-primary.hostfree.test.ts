/**
 * Host-free coverage for follow-primary dial shape and enqueue skip rules.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import type { ManagedMemberPeer, ManagedMemberRow } from './members.ts'
import {
  enqueueFollowPrimaryOnReplicas,
  membersEligibleToFollowPrimary,
  replicaFollowPrimaryDial,
} from './follow-primary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const PRIMARY_ID = '00000000-0000-4000-8000-000000000020'
const REPLICA_ID = '00000000-0000-4000-8000-000000000021'
const READ_ID = '00000000-0000-4000-8000-000000000022'
const SERVER_A = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const SERVER_C = '7ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ACTOR_ID = '00000000-0000-4000-8000-000000000099'
const NOW = '2026-01-01T00:00:00.000Z'

function member(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return {
    id: PRIMARY_ID,
    managedId: MANAGED_ID,
    serverId: SERVER_A,
    role: 'primary',
    replicaClass: null,
    readEligible: true,
    ordinal: 1,
    replicationTransport: null,
    privatePort: 45001,
    status: 'ready',
    metadata: null,
    options: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function replicaMember(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return member({
    id: REPLICA_ID,
    role: 'replica',
    replicaClass: 'failover',
    serverId: SERVER_B,
    ordinal: 2,
    ...overrides,
  })
}

function okQueue(): CommandQueue {
  return { enqueue: () => Promise.resolve() }
}

test('replicaFollowPrimaryDial uses the container name when the primary is local', () => {
  assertEquals(
    replicaFollowPrimaryDial(MANAGED_ID, {
      address: 'pg-primary',
      port: 5432,
      containerName: 'pg-primary',
    }),
    { targetHost: 'pg-primary', targetPort: 5432 }
  )
})

test('replicaFollowPrimaryDial uses the leaf SAN and dial IP when the primary is remote', () => {
  assertEquals(
    replicaFollowPrimaryDial(MANAGED_ID, {
      address: '203.0.113.10',
      port: 45001,
    }),
    {
      targetHost: `managed-${MANAGED_ID}`,
      targetPort: 45001,
      targetHostaddr: '203.0.113.10',
    }
  )
})

test('membersEligibleToFollowPrimary skips the new primary and unhealthy members', () => {
  const rows = [
    member(),
    replicaMember(),
    replicaMember({
      id: READ_ID,
      serverId: SERVER_C,
      replicaClass: 'read',
      ordinal: 3,
      status: 'needs_resync',
    }),
    replicaMember({
      id: '00000000-0000-4000-8000-000000000023',
      serverId: SERVER_C,
      ordinal: 4,
      status: 'failed',
    }),
  ]
  assertEquals(
    membersEligibleToFollowPrimary(rows, PRIMARY_ID).map((row) => row.id),
    [REPLICA_ID]
  )
})

test('enqueueFollowPrimaryOnReplicas queues one follow-primary for each remaining replica', async () => {
  const enqueued: Array<{ serverId: string; payload: Record<string, unknown> }> = []
  const primaryPeer: ManagedMemberPeer = {
    memberId: PRIMARY_ID,
    role: 'primary',
    readEligible: true,
    address: '203.0.113.10',
    transport: 'datacenter',
    port: 45001,
  }
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
      engine: 'postgres',
    },
    {
      listMembers: () => Promise.resolve([member(), replicaMember()]),
      loadDefaultPort: () => Promise.resolve(5432),
      outstandingMemberIds: () => Promise.resolve(new Set()),
      resolvePeers: () => Promise.resolve([primaryPeer]),
      enqueue: (_db, _queue, spec) => {
        enqueued.push({
          serverId: spec.serverId,
          payload: spec.payload as Record<string, unknown>,
        })
        return Promise.resolve(true)
      },
    }
  )
  assertEquals(enqueued.length, 1)
  assertEquals(enqueued[0]?.serverId, SERVER_B)
  assertEquals(enqueued[0]?.payload.phase, 'repoint')
  assertEquals(enqueued[0]?.payload.targetHost, `managed-${MANAGED_ID}`)
  assertEquals(enqueued[0]?.payload.targetHostaddr, '203.0.113.10')
  assertEquals(enqueued[0]?.payload.targetPort, 45001)
  assertEquals(enqueued[0]?.payload.sourceMemberId, REPLICA_ID)
  assertEquals(enqueued[0]?.payload.targetMemberId, PRIMARY_ID)
})

test('enqueueFollowPrimaryOnReplicas is a no-op when a follow-primary is already queued', async () => {
  let enqueueCalls = 0
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
    },
    {
      listMembers: () => Promise.resolve([member(), replicaMember()]),
      loadDefaultPort: () => Promise.resolve(5432),
      outstandingMemberIds: () => Promise.resolve(new Set([REPLICA_ID])),
      resolvePeers: () => Promise.reject(new TypeError('must not resolve peers')),
      enqueue: () => {
        enqueueCalls += 1
        return Promise.resolve(true)
      },
    }
  )
  assertEquals(enqueueCalls, 0)
})

test('enqueueFollowPrimaryOnReplicas logs a missing path and does not throw', async () => {
  let enqueueCalls = 0
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
    },
    {
      listMembers: () => Promise.resolve([member(), replicaMember()]),
      loadDefaultPort: () => Promise.resolve(5432),
      outstandingMemberIds: () => Promise.resolve(new Set()),
      resolvePeers: () =>
        Promise.resolve({
          kind: 'private_path_unavailable',
          fromServerId: SERVER_B,
          toServerId: SERVER_A,
        }),
      enqueue: () => {
        enqueueCalls += 1
        return Promise.resolve(true)
      },
    }
  )
  assertEquals(enqueueCalls, 0)
})

test('enqueueFollowPrimaryOnReplicas keeps going when one replica enqueue fails', async () => {
  const enqueuedMemberIds: string[] = []
  const primaryPeer: ManagedMemberPeer = {
    memberId: PRIMARY_ID,
    role: 'primary',
    readEligible: true,
    address: 'pg-primary',
    transport: 'local',
    port: 5432,
    containerName: 'pg-primary',
  }
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
    },
    {
      listMembers: () =>
        Promise.resolve([
          member(),
          replicaMember(),
          replicaMember({ id: READ_ID, serverId: SERVER_C, ordinal: 3, replicaClass: 'read' }),
        ]),
      loadDefaultPort: () => Promise.resolve(5432),
      outstandingMemberIds: () => Promise.resolve(new Set()),
      resolvePeers: () => Promise.resolve([primaryPeer]),
      enqueue: (_db, _queue, spec) => {
        if (spec.memberId === REPLICA_ID) return Promise.resolve(false)
        enqueuedMemberIds.push(spec.memberId)
        return Promise.resolve(true)
      },
    }
  )
  assertEquals(enqueuedMemberIds, [READ_ID])
})

test('enqueueFollowPrimaryOnReplicas never throws when listing members fails', async () => {
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
    },
    {
      listMembers: () => Promise.reject(new Error('database connection reset')),
    }
  )
})

test('enqueueFollowPrimaryOnReplicas is a no-op without a command queue', async () => {
  let listed = false
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    undefined,
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
    },
    {
      listMembers: () => {
        listed = true
        return Promise.resolve([])
      },
    }
  )
  assertEquals(listed, false)
})
