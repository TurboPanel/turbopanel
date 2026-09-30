/**
 * Host-free coverage for the backup policy push (no Postgres): the full set a
 * server gets, the enqueue outcome, and the move helper that follows an
 * engine to a new host.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { retention, command, dispatch, managed, storageCopy } from '../../db/schema.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import { createNoopCommandQueue } from '../commands/noop-command-queue.ts'
import {
  buildBackupPolicySetForServer,
  captureCopyBackupHosts,
  captureManagedBackupHost,
  enqueueBackupsReconcile,
  reconcileBackupsAfterCopyChange,
  reconcileBackupsAfterManagedMove,
} from './reconcile.ts'
import type { CopyTargetRow } from './copy-targets.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER_A = '0192d6a0-0000-7000-8000-00000000000a'
const SERVER_B = '0192d6a0-0000-7000-8000-00000000000b'
const MANAGED_ID = '0192d6a0-0000-7000-8000-0000000000e1'
const NOW = '2026-09-30T00:00:00.000Z'

type PolicyRow = {
  id: string
  managedId: string | null
  schedule: string
  timezone: string | null
  retentionKeep: number
  isEnabled: boolean
  engine: string
}

function policyRow(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: '0192d6a0-0000-7000-8000-0000000000a1',
    managedId: MANAGED_ID,
    schedule: '30 2 * * *',
    timezone: null,
    retentionKeep: 7,
    isEnabled: true,
    engine: 'postgres',
    ...overrides,
  }
}

function chain(rows: unknown[]): Record<string, unknown> {
  const promise = Promise.resolve(rows)
  const next: Record<string, unknown> = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
  for (const method of [
    'where',
    'limit',
    'orderBy',
    'innerJoin',
    'leftJoin',
    'set',
    'values',
    'returning',
  ]) {
    next[method] = () => chain(rows)
  }
  return next
}

type CopyPolicyRow = CopyTargetRow & {
  id: string
  schedule: string
  timezone: string | null
  retentionKeep: number
  isEnabled: boolean
}

const COPY_ID = '0192d6a0-0000-7000-8000-0000000000c1'
const STORAGE_ID = '0192d6a0-0000-7000-8000-0000000000d1'
const ORG_ID = '0192d6a0-0000-7000-8000-0000000000f1'

function copyPolicyRow(overrides: Partial<CopyPolicyRow> = {}): CopyPolicyRow {
  return {
    id: '0192d6a0-0000-7000-8000-0000000000b1',
    copyId: COPY_ID,
    serverId: SERVER_A,
    provider: 'docker',
    copyPath: null,
    copyOptions: { managed: true },
    storageId: STORAGE_ID,
    organizationId: ORG_ID,
    storageKind: 'volume',
    storageMetadata: null,
    principalUsername: null,
    schedule: '0 * * * *',
    timezone: null,
    retentionKeep: 24,
    isEnabled: true,
    ...overrides,
  }
}

type FakeState = {
  policyRows: PolicyRow[]
  copyPolicyRows: CopyPolicyRow[]
  /** `copy.server_id` of copies with a policy, consumed in order (the last one repeats). */
  copyHostAnswers: string[][]
  hasPolicy: boolean
  /** `managed.server_id` answers, consumed in order (the last one repeats). */
  managedServerIds: Array<string | null>
  dispatchPayloads: unknown[]
  commandStatuses: string[]
}

function fakeDb(state: Partial<FakeState> = {}): { db: Db; state: FakeState } {
  const full: FakeState = {
    policyRows: state.policyRows ?? [],
    copyPolicyRows: state.copyPolicyRows ?? [],
    copyHostAnswers: state.copyHostAnswers ?? [[]],
    hasPolicy: state.hasPolicy ?? true,
    managedServerIds: state.managedServerIds ?? [SERVER_A],
    dispatchPayloads: [],
    commandStatuses: [],
  }
  let commandSeq = 0
  const nextServerId = (): string | null =>
    full.managedServerIds.length > 1
      ? (full.managedServerIds.shift() ?? null)
      : (full.managedServerIds[0] ?? null)

  const nextCopyHosts = (): string[] =>
    full.copyHostAnswers.length > 1
      ? (full.copyHostAnswers.shift() ?? [])
      : (full.copyHostAnswers[0] ?? [])

  const db = {
    selectDistinct: () => ({
      from: () => chain(nextCopyHosts().map((serverId) => ({ serverId }))),
    }),
    select: () => ({
      from: (table: unknown) => {
        if (table === retention) {
          // The managed set joins `managed`, the copy set joins `copy`; the
          // existence check joins nothing.
          const base = chain(full.hasPolicy ? [{ id: 'p' }] : [])
          base.innerJoin = (joined: unknown) =>
            chain(joined === storageCopy ? full.copyPolicyRows : full.policyRows)
          return base
        }
        if (table === managed) return chain([{ serverId: nextServerId() }])
        return chain([])
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === dispatch) {
          full.dispatchPayloads.push(values.payload)
          return chain([])
        }
        if (table === command) {
          commandSeq += 1
          full.commandStatuses.push('queued')
          return chain([
            {
              id: `0192d6a0-0000-7000-8000-00000000c00${commandSeq}`,
              serverId: values.serverId,
              actorType: values.actorType,
              actorId: values.actorId,
              name: values.name,
              status: 'queued',
              createdAt: NOW,
              updatedAt: NOW,
              queuedAt: NOW,
            },
          ])
        }
        return chain([])
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        if (table === command && typeof values.status === 'string') {
          full.commandStatuses.push(values.status)
        }
        return chain([])
      },
    }),
    delete: () => chain([]),
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  }
  return { db: db as unknown as Db, state: full }
}

function capturingQueue(fail = false): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope: CommandEnvelope) => {
      if (fail) return Promise.reject(new Error('queue down'))
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

const ACTOR = { actorType: 'user', actorId: '0192d6a0-0000-7000-8000-0000000000u1' }

test('the set holds every policy on the server, disabled ones as enabled:false', async () => {
  const { db } = fakeDb({
    policyRows: [
      policyRow(),
      policyRow({
        id: '0192d6a0-0000-7000-8000-0000000000a2',
        isEnabled: false,
        schedule: '0 * * * *',
        timezone: 'Europe/London',
        retentionKeep: 24,
      }),
      policyRow({ id: '0192d6a0-0000-7000-8000-0000000000a3', engine: 'mysql' }),
    ],
  })
  const set = await buildBackupPolicySetForServer(db, SERVER_A)
  assertEquals(set.length, 3)
  assertEquals(set[0]?.policyId, '0192d6a0-0000-7000-8000-0000000000a1')
  assertEquals(set[0]?.targetKind, 'managed')
  assertEquals(set[0]?.managedId, MANAGED_ID)
  assertEquals(set[0]?.engine, 'postgres')
  assertEquals(set[0]?.artifactExtension, 'dump')
  assertEquals(set[0]?.retentionKeep, 7)
  assertEquals(set[0]?.enabled, true)
  assertEquals(set[0]?.onCalendar.includes('2:30:00'), true)
  assertEquals(set[1]?.enabled, false)
  assertEquals(set[1]?.onCalendar.endsWith(' Europe/London'), true)
  assertEquals(set[2]?.artifactExtension, 'sql')
})

test('engines without backup support and untranslatable schedules are left out', async () => {
  const { db } = fakeDb({
    policyRows: [
      policyRow({ engine: 'redis' }),
      policyRow({ id: '0192d6a0-0000-7000-8000-0000000000a2', schedule: '@reboot' }),
      policyRow({ id: '0192d6a0-0000-7000-8000-0000000000a3' }),
    ],
  })
  const set = await buildBackupPolicySetForServer(db, SERVER_A)
  assertEquals(
    set.map((entry) => entry.policyId),
    ['0192d6a0-0000-7000-8000-0000000000a3']
  )
})

test('a set the daemon would refuse is never built', async () => {
  const duplicate = policyRow()
  const { db } = fakeDb({ policyRows: [duplicate, { ...duplicate }] })
  await assertRejects(() => buildBackupPolicySetForServer(db, SERVER_A))
})

test('each server is reconciled once, nulls skipped, with its full set', async () => {
  const { db, state } = fakeDb({ policyRows: [policyRow()] })
  const queue = capturingQueue()
  const outcome = await enqueueBackupsReconcile(db, queue, ACTOR, [
    SERVER_A,
    null,
    SERVER_A,
    undefined,
    SERVER_B,
  ])
  assertEquals(outcome, { queuedServerIds: [SERVER_A, SERVER_B], failedServerIds: [] })
  assertEquals(
    queue.envelopes.map((envelope) => [envelope.type, envelope.serverId]),
    [
      ['server.backups.reconcile', SERVER_A],
      ['server.backups.reconcile', SERVER_B],
    ]
  )
  assertEquals((state.dispatchPayloads[0] as { policies: unknown[] }).policies.length, 1)
})

test('no queue means every server is reported failed, nothing written', async () => {
  const { db, state } = fakeDb()
  assertEquals(await enqueueBackupsReconcile(db, undefined, ACTOR, [SERVER_A]), {
    queuedServerIds: [],
    failedServerIds: [SERVER_A],
  })
  assertEquals(await enqueueBackupsReconcile(db, createNoopCommandQueue(), ACTOR, [SERVER_A]), {
    queuedServerIds: [],
    failedServerIds: [SERVER_A],
  })
  assertEquals(state.dispatchPayloads.length, 0)
})

test('a queue failure marks the command failed and never throws', async () => {
  const { db, state } = fakeDb()
  const outcome = await enqueueBackupsReconcile(db, capturingQueue(true), ACTOR, [SERVER_A])
  assertEquals(outcome, { queuedServerIds: [], failedServerIds: [SERVER_A] })
  assertEquals(state.commandStatuses, ['queued', 'failed'])
})

test('the host is only captured when there is a queue and a policy', async () => {
  const withPolicy = fakeDb({ hasPolicy: true, managedServerIds: [SERVER_A] })
  assertEquals(
    await captureManagedBackupHost(withPolicy.db, capturingQueue(), MANAGED_ID),
    SERVER_A
  )
  const noPolicy = fakeDb({ hasPolicy: false })
  assertEquals(await captureManagedBackupHost(noPolicy.db, capturingQueue(), MANAGED_ID), null)
  assertEquals(await captureManagedBackupHost(withPolicy.db, undefined, MANAGED_ID), null)
})

test('a move reconciles both hosts; an unchanged pin reconciles none', async () => {
  const moved = fakeDb({ policyRows: [policyRow()], managedServerIds: [SERVER_B] })
  const queue = capturingQueue()
  await reconcileBackupsAfterManagedMove(moved.db, queue, {
    managedId: MANAGED_ID,
    previousServerId: SERVER_A,
    actorId: SERVER_B,
  })
  assertEquals(
    queue.envelopes.map((envelope) => envelope.serverId),
    [SERVER_A, SERVER_B]
  )

  const stayed = fakeDb({ managedServerIds: [SERVER_A] })
  const quiet = capturingQueue()
  await reconcileBackupsAfterManagedMove(stayed.db, quiet, {
    managedId: MANAGED_ID,
    previousServerId: SERVER_A,
    actorId: SERVER_A,
  })
  await reconcileBackupsAfterManagedMove(stayed.db, quiet, {
    managedId: MANAGED_ID,
    previousServerId: null,
    actorId: SERVER_A,
  })
  assertEquals(quiet.envelopes.length, 0)
})

test('copy policies join the set with where their bytes live', async () => {
  const { db } = fakeDb({
    copyPolicyRows: [
      copyPolicyRow(),
      copyPolicyRow({
        id: '0192d6a0-0000-7000-8000-0000000000b2',
        provider: 'path',
        storageKind: 'directory',
        principalUsername: 'acme',
        isEnabled: false,
      }),
      copyPolicyRow({
        id: '0192d6a0-0000-7000-8000-0000000000b3',
        provider: 'path',
        storageKind: 'directory',
      }),
    ],
  })
  const set = await buildBackupPolicySetForServer(db, SERVER_A)
  assertEquals(set, [
    {
      policyId: '0192d6a0-0000-7000-8000-0000000000b1',
      targetKind: 'copy',
      onCalendar: '*-*-* *:0:00',
      retentionKeep: 24,
      enabled: true,
      copyId: COPY_ID,
      copyProvider: 'docker',
      volumeName: STORAGE_ID,
    },
    {
      policyId: '0192d6a0-0000-7000-8000-0000000000b2',
      targetKind: 'copy',
      onCalendar: '*-*-* *:0:00',
      retentionKeep: 24,
      enabled: false,
      copyId: COPY_ID,
      copyProvider: 'path',
      hostPath: `/srv/users/acme/volumes/${STORAGE_ID}`,
    },
    {
      policyId: '0192d6a0-0000-7000-8000-0000000000b3',
      targetKind: 'copy',
      onCalendar: '*-*-* *:0:00',
      retentionKeep: 24,
      enabled: true,
      copyId: COPY_ID,
      copyProvider: 'path',
      organizationId: ORG_ID,
      storageId: STORAGE_ID,
    },
  ])
})

test('copies that can no longer be backed up are left out of the set', async () => {
  const { db } = fakeDb({
    copyPolicyRows: [
      copyPolicyRow({ provider: 's3' }),
      copyPolicyRow({ id: '0192d6a0-0000-7000-8000-0000000000b2', storageKind: 'file' }),
      copyPolicyRow({
        id: '0192d6a0-0000-7000-8000-0000000000b3',
        provider: 'path',
        storageKind: 'directory',
        copyPath: '/etc',
      }),
    ],
  })
  assertEquals(await buildBackupPolicySetForServer(db, SERVER_A), [])
})

test('a copy change pushes the old hosts and the copy’s current host, once each', async () => {
  const { db } = fakeDb({ copyHostAnswers: [[SERVER_A], [SERVER_B]] })
  const queue = capturingQueue()
  const before = await captureCopyBackupHosts(db, queue, { copyIds: [COPY_ID] })
  assertEquals(before, [SERVER_A])
  await reconcileBackupsAfterCopyChange(db, queue, {
    copyIds: [COPY_ID],
    previousServerIds: before,
    actor: ACTOR,
  })
  assertEquals(
    queue.envelopes.map((envelope) => envelope.serverId),
    [SERVER_A, SERVER_B]
  )
})

test('a copy change with no policy anywhere pushes nothing', async () => {
  const { db } = fakeDb({ copyHostAnswers: [[]] })
  const queue = capturingQueue()
  const before = await captureCopyBackupHosts(db, queue, { storageId: STORAGE_ID })
  assertEquals(before, [])
  await reconcileBackupsAfterCopyChange(db, queue, {
    copyIds: [],
    previousServerIds: [],
    actor: ACTOR,
  })
  assertEquals(queue.envelopes, [])
  assertEquals(
    await captureCopyBackupHosts(db, createNoopCommandQueue(), { copyIds: [COPY_ID] }),
    []
  )
})
