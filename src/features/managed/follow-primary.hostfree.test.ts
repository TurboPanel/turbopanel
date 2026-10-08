/**
 * Host-free coverage for follow-primary dial shape and enqueue skip rules.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { CommandQueue } from '../commands/queue.ts'
import type { ManagedMemberPeer, ManagedMemberRow } from './members.ts'
import {
  enqueueFollowPrimaryOnReplicas,
  managedMemberSlotName,
  membersEligibleToFollowPrimary,
  replicaFollowPrimaryDial,
  type FollowPrimaryEnqueueDeps,
  type OutstandingFollowPrimary,
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
const OLD_PRIMARY_ID = '00000000-0000-4000-8000-000000000019'

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

const primaryPeer: ManagedMemberPeer = {
  memberId: PRIMARY_ID,
  role: 'primary',
  readEligible: true,
  address: '203.0.113.10',
  transport: 'datacenter',
  port: 45001,
}

function followDeps(
  enqueued: Array<{ serverId: string; memberId: string; payload: Record<string, unknown> }>,
  overrides: FollowPrimaryEnqueueDeps = {}
): FollowPrimaryEnqueueDeps {
  return {
    listMembers: () => Promise.resolve([member(), replicaMember()]),
    loadEngine: () => Promise.resolve({ engine: 'postgres', defaultPort: 5432 }),
    loadConnectedServerIds: (_db, ids) => Promise.resolve(new Set(ids)),
    outstandingRepoints: () => Promise.resolve([]),
    resolvePeer: () => Promise.resolve(primaryPeer),
    enqueue: (_db, _queue, spec) => {
      enqueued.push({
        serverId: spec.serverId,
        memberId: spec.memberId,
        payload: spec.payload as Record<string, unknown>,
      })
      return Promise.resolve(true)
    },
    ...overrides,
  }
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

test('managedMemberSlotName follows the apply slot convention', () => {
  assertEquals(managedMemberSlotName(2), 'tp_member_2')
})

test('membersEligibleToFollowPrimary is a whitelist of healthy replicas', () => {
  const rows = [
    member(),
    replicaMember(),
    replicaMember({
      id: READ_ID,
      serverId: SERVER_C,
      replicaClass: 'read',
      ordinal: 3,
      status: 'streaming',
    }),
    replicaMember({
      id: '00000000-0000-4000-8000-000000000023',
      serverId: SERVER_C,
      ordinal: 4,
      status: 'needs_resync',
    }),
    replicaMember({
      id: '00000000-0000-4000-8000-000000000024',
      serverId: SERVER_C,
      ordinal: 5,
      status: 'failed',
    }),
    replicaMember({
      id: '00000000-0000-4000-8000-000000000025',
      serverId: SERVER_C,
      ordinal: 6,
      status: 'provisioning',
    }),
    replicaMember({
      id: '00000000-0000-4000-8000-000000000026',
      serverId: SERVER_C,
      ordinal: 7,
      status: 'applying',
    }),
    replicaMember({
      id: '00000000-0000-4000-8000-000000000027',
      serverId: SERVER_C,
      ordinal: 8,
      status: 'stopped',
    }),
  ]
  assertEquals(
    membersEligibleToFollowPrimary(rows, PRIMARY_ID).map((row) => row.id),
    [REPLICA_ID, READ_ID]
  )
  assertEquals(
    membersEligibleToFollowPrimary(rows, PRIMARY_ID, new Set([SERVER_B])).map((row) => row.id),
    [REPLICA_ID]
  )
})

test('enqueueFollowPrimaryOnReplicas queues slot-ensure then one follow-primary per replica', async () => {
  const enqueued: Array<{ serverId: string; memberId: string; payload: Record<string, unknown> }> =
    []
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
      engine: 'postgres',
    },
    followDeps(enqueued)
  )
  assertEquals(enqueued.length, 2)
  assertEquals(enqueued[0]?.serverId, SERVER_A)
  assertEquals(enqueued[0]?.payload.phase, 'repoint')
  assertEquals(enqueued[0]?.payload.engine, 'postgres')
  assertEquals(enqueued[0]?.payload.sourceMemberId, PRIMARY_ID)
  assertEquals(enqueued[0]?.payload.targetMemberId, PRIMARY_ID)
  assertEquals(enqueued[0]?.payload.ensureSlots, ['tp_member_2'])
  assertEquals(enqueued[0]?.payload.targetHost, undefined)
  assertEquals(enqueued[1]?.serverId, SERVER_B)
  assertEquals(enqueued[1]?.payload.phase, 'repoint')
  assertEquals(enqueued[1]?.payload.engine, 'postgres')
  assertEquals(enqueued[1]?.payload.targetHost, `managed-${MANAGED_ID}`)
  assertEquals(enqueued[1]?.payload.targetHostaddr, '203.0.113.10')
  assertEquals(enqueued[1]?.payload.targetPort, 45001)
  assertEquals(enqueued[1]?.payload.sourceMemberId, REPLICA_ID)
  assertEquals(enqueued[1]?.payload.targetMemberId, PRIMARY_ID)
})

test('enqueueFollowPrimaryOnReplicas loads engine from the cluster when omitted', async () => {
  const enqueued: Array<{ serverId: string; memberId: string; payload: Record<string, unknown> }> =
    []
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
    },
    followDeps(enqueued, {
      loadEngine: () => Promise.resolve({ engine: 'mysql', defaultPort: 3306 }),
    })
  )
  assertEquals(enqueued[0]?.payload.engine, 'mysql')
  assertEquals(enqueued[1]?.payload.engine, 'mysql')
})

test('enqueueFollowPrimaryOnReplicas skips a replica already queued for the same target', async () => {
  const enqueued: Array<{ serverId: string; memberId: string; payload: Record<string, unknown> }> =
    []
  const outstanding: OutstandingFollowPrimary[] = [
    { commandId: 'cmd-same', memberId: REPLICA_ID, targetMemberId: PRIMARY_ID },
  ]
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
      engine: 'postgres',
    },
    followDeps(enqueued, {
      outstandingRepoints: () => Promise.resolve(outstanding),
    })
  )
  assertEquals(
    enqueued.map((row) => row.memberId),
    [PRIMARY_ID]
  )
})

test('enqueueFollowPrimaryOnReplicas cancels a stale target and queues the new one', async () => {
  const cancelled: string[] = []
  const enqueued: Array<{ serverId: string; memberId: string; payload: Record<string, unknown> }> =
    []
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
      engine: 'postgres',
    },
    followDeps(enqueued, {
      outstandingRepoints: () =>
        Promise.resolve([
          { commandId: 'cmd-stale', memberId: REPLICA_ID, targetMemberId: OLD_PRIMARY_ID },
        ]),
      cancelCommand: (_db, commandId) => {
        cancelled.push(commandId)
        return Promise.resolve()
      },
    })
  )
  assertEquals(cancelled, ['cmd-stale'])
  assertEquals(
    enqueued.map((row) => row.memberId),
    [PRIMARY_ID, REPLICA_ID]
  )
  assertEquals(enqueued[1]?.payload.targetMemberId, PRIMARY_ID)
})

test('enqueueFollowPrimaryOnReplicas logs a missing path and does not throw', async () => {
  const enqueued: Array<{ serverId: string; memberId: string; payload: Record<string, unknown> }> =
    []
  await enqueueFollowPrimaryOnReplicas(
    {} as Db,
    okQueue(),
    {
      managedId: MANAGED_ID,
      newPrimaryMemberId: PRIMARY_ID,
      actorId: ACTOR_ID,
      engine: 'postgres',
    },
    followDeps(enqueued, {
      resolvePeer: () =>
        Promise.resolve({
          kind: 'private_path_unavailable',
          fromServerId: SERVER_B,
          toServerId: SERVER_A,
        }),
    })
  )
  assertEquals(
    enqueued.map((row) => row.memberId),
    [PRIMARY_ID]
  )
})

test('enqueueFollowPrimaryOnReplicas keeps going when one replica enqueue fails', async () => {
  const enqueuedMemberIds: string[] = []
  const localPeer: ManagedMemberPeer = {
    ...primaryPeer,
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
      engine: 'postgres',
    },
    followDeps([], {
      listMembers: () =>
        Promise.resolve([
          member(),
          replicaMember(),
          replicaMember({ id: READ_ID, serverId: SERVER_C, ordinal: 3, replicaClass: 'read' }),
        ]),
      resolvePeer: () => Promise.resolve(localPeer),
      enqueue: (_db, _queue, spec) => {
        if (spec.memberId === REPLICA_ID) return Promise.resolve(false)
        enqueuedMemberIds.push(spec.memberId)
        return Promise.resolve(true)
      },
    })
  )
  assertEquals(enqueuedMemberIds, [PRIMARY_ID, READ_ID])
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
