/**
 * Host-free coverage for planned-switchover re-seed of a demoted primary.
 */

import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import type { CommandQueue } from '../commands/queue.ts'
import type { BuildManagedApplyInput, PreparedManagedMemberApply } from './apply-prepare.ts'
import type { ManagedMemberRow } from './members.ts'
import type { RecoveryRecord } from './recovery.ts'
import {
  reseedDemotedPrimaryAfterSwitchover,
  type ManagedApplyCluster,
  type ReseedDemotedPrimaryDeps,
} from './reseed-demoted-primary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = '00000000-0000-4000-8000-000000000001'
const REC_ID = '00000000-0000-4000-8000-000000000010'
const OTHER_REC = '00000000-0000-4000-8000-000000000011'
const SOURCE_ID = '00000000-0000-4000-8000-000000000020'
const TARGET_ID = '00000000-0000-4000-8000-000000000021'
const SERVER_OLD = '550e8400-e29b-41d4-a716-446655440000'
const SERVER_NEW = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const ACTOR_ID = '00000000-0000-4000-8000-000000000099'
const NOW = '2026-01-01T00:00:00.000Z'
const ENV_ID = '00000000-0000-4000-8000-000000000030'
const ORG_ID = '00000000-0000-4000-8000-000000000040'

const db = {} as Db
const secretsConfig = {} as SecretsConfig
const dataEncryptionSecrets = {} as DerivedSecretsConfig
const secrets = { secretsConfig, dataEncryptionSecrets }
const queue: CommandQueue = { enqueue: () => Promise.resolve() }

function member(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return {
    id: SOURCE_ID,
    managedId: MANAGED_ID,
    serverId: SERVER_OLD,
    role: 'replica',
    replicaClass: 'failover',
    readEligible: true,
    ordinal: 1,
    replicationTransport: null,
    privatePort: 5432,
    status: 'needs_resync',
    metadata: null,
    options: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function demoted(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return member(overrides)
}

function promoted(overrides: Partial<ManagedMemberRow> = {}): ManagedMemberRow {
  return member({
    id: TARGET_ID,
    serverId: SERVER_NEW,
    role: 'primary',
    replicaClass: null,
    ordinal: 2,
    status: 'ready',
    ...overrides,
  })
}

function switchoverRecord(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    id: REC_ID,
    managedId: MANAGED_ID,
    kind: 'switchover',
    sourcePrimaryMemberId: SOURCE_ID,
    targetMemberId: TARGET_ID,
    state: 'repointing',
    startedAt: NOW,
    completedAt: null,
    metadata: { stopApplied: true },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function clusterRow(overrides: Partial<ManagedApplyCluster> = {}): ManagedApplyCluster {
  return {
    id: MANAGED_ID,
    environmentId: ENV_ID,
    organizationId: ORG_ID,
    engine: 'postgres',
    status: 'ready',
    metadata: null,
    options: { settings: {}, databases: ['postgres'] },
    serverId: SERVER_NEW,
    ...overrides,
  }
}

type EnqueueCall = {
  managedId: string
  members: PreparedManagedMemberApply[]
  prepareServerId?: string
  forceResyncMemberIds?: string[]
}

function capturingDeps(enqueued: EnqueueCall[], extra: ReseedDemotedPrimaryDeps = {}) {
  let prepareServerId: string | undefined
  let forceResyncMemberIds: string[] | undefined
  const deps: ReseedDemotedPrimaryDeps = {
    listMembers: () => Promise.resolve([demoted(), promoted()]),
    isServerConnected: () => Promise.resolve(true),
    findInFlightRecovery: () => Promise.resolve(switchoverRecord()),
    hasOutstandingApply: () => Promise.resolve(false),
    loadCluster: () => Promise.resolve(clusterRow()),
    preflight: () => Promise.resolve(null),
    preparePayloads: (_c: Context, _db: Db, input: BuildManagedApplyInput) => {
      prepareServerId = input.serverId
      forceResyncMemberIds = input.forceResyncMemberIds
      const forceResync = input.forceResyncMemberIds?.includes(SOURCE_ID) === true
      return Promise.resolve({
        members: [
          {
            memberId: TARGET_ID,
            serverId: SERVER_NEW,
            payload: { managedId: MANAGED_ID, memberRole: 'primary' } as never,
          },
          {
            memberId: SOURCE_ID,
            serverId: SERVER_OLD,
            payload: {
              managedId: MANAGED_ID,
              memberRole: 'standby',
              ...(forceResync ? { forceResync: true } : {}),
            } as never,
          },
        ],
      })
    },
    enqueueApply: (_c, _db, _queue, params) => {
      enqueued.push({
        managedId: params.managedId,
        members: params.members,
        prepareServerId,
        forceResyncMemberIds,
      })
      return Promise.resolve(
        params.members.map((row) => ({
          memberId: row.memberId,
          serverId: row.serverId,
          status: 'queued' as const,
          commandId: 'cmd-1',
        }))
      )
    },
    ...extra,
  }
  return deps
}

async function reseed(deps: ReseedDemotedPrimaryDeps, record = switchoverRecord()) {
  await reseedDemotedPrimaryAfterSwitchover(db, queue, secrets, record, ACTOR_ID, deps)
}

test('switchover with a demoted needs_resync member enqueues one force-resync apply on the new primary', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(capturingDeps(enqueued))
  assertEquals(enqueued.length, 1)
  assertEquals(enqueued[0]?.managedId, MANAGED_ID)
  assertEquals(enqueued[0]?.prepareServerId, SERVER_NEW)
  assertEquals(enqueued[0]?.forceResyncMemberIds, [SOURCE_ID])
  const standby = enqueued[0]?.members.find((row) => row.memberId === SOURCE_ID)
  assertEquals(standby?.payload.forceResync, true)
  assertEquals(
    enqueued[0]?.members.some((row) => row.serverId === SERVER_NEW),
    true
  )
})

test('automatic-failover does not enqueue a reseed', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(capturingDeps(enqueued), switchoverRecord({ kind: 'automatic-failover' }))
  assertEquals(enqueued.length, 0)
})

test('disaster-recovery does not enqueue a reseed', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(capturingDeps(enqueued), switchoverRecord({ kind: 'disaster-recovery' }))
  assertEquals(enqueued.length, 0)
})

test('a source member that is not needs_resync is a no-op', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(
    capturingDeps(enqueued, {
      listMembers: () => Promise.resolve([demoted({ status: 'ready' }), promoted()]),
    })
  )
  assertEquals(enqueued.length, 0)
})

test('an offline source server is a no-op', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(
    capturingDeps(enqueued, {
      isServerConnected: () => Promise.resolve(false),
    })
  )
  assertEquals(enqueued.length, 0)
})

test('missing secrets are a no-op', async () => {
  const enqueued: EnqueueCall[] = []
  await reseedDemotedPrimaryAfterSwitchover(
    db,
    queue,
    {},
    switchoverRecord(),
    ACTOR_ID,
    capturingDeps(enqueued)
  )
  assertEquals(enqueued.length, 0)
})

test('another recovery in flight is a no-op', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(
    capturingDeps(enqueued, {
      findInFlightRecovery: () =>
        Promise.resolve(switchoverRecord({ id: OTHER_REC, kind: 'automatic-failover' })),
    })
  )
  assertEquals(enqueued.length, 0)
})

test('an unproven fence stop is a no-op', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(capturingDeps(enqueued), switchoverRecord({ metadata: {} }))
  assertEquals(enqueued.length, 0)
})

test('a second call is a no-op once a managed.apply is already queued', async () => {
  const enqueued: EnqueueCall[] = []
  let outstanding = false
  const base = capturingDeps(enqueued)
  const deps: ReseedDemotedPrimaryDeps = {
    ...base,
    hasOutstandingApply: () => Promise.resolve(outstanding),
    enqueueApply: async (c, applyDb, commandQueue, params) => {
      const result = await base.enqueueApply!(c, applyDb, commandQueue, params)
      outstanding = true
      return result
    },
  }
  await reseed(deps)
  await reseed(deps)
  assertEquals(enqueued.length, 1)
})

test('missing command queue is a no-op', async () => {
  const enqueued: EnqueueCall[] = []
  await reseedDemotedPrimaryAfterSwitchover(
    db,
    undefined,
    secrets,
    switchoverRecord(),
    ACTOR_ID,
    capturingDeps(enqueued)
  )
  assertEquals(enqueued.length, 0)
})

test('enqueue failure does not throw', async () => {
  const enqueued: EnqueueCall[] = []
  await reseed(
    capturingDeps(enqueued, {
      enqueueApply: () => Promise.reject(new TypeError('queue unavailable')),
    })
  )
  assertEquals(enqueued.length, 0)
})
