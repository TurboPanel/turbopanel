import { assertEquals } from '@std/assert'
import { getTableName } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { CaRotationResultRow } from './changeover-fanout.ts'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  CA_ROTATION_TARGET_GONE,
  enqueueMissingCaRotationApplies,
  loadReconciledRotationWithCommandRecords,
  reconcileCaRotationResults,
  rotationApplyRowKey,
  rotationConvergedForRetire,
  rotationResultReason,
  rotationRowConverged,
} from './rotation-converge.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STANDBY_SERVER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MANAGED = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'
const COMMAND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PRIMARY_COMMAND = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ORG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const noopQueue: CommandQueue = { enqueue: () => Promise.resolve() }
const noopContext = {} as Context<AppEnv>

function applyRow(overrides: Partial<CaRotationResultRow> = {}): CaRotationResultRow {
  return {
    serverId: SERVER,
    kind: 'apply',
    managedId: MANAGED,
    status: 'queued',
    ...overrides,
  }
}

test('rotationRowConverged accepts skipped target_gone without commandId', () => {
  assertEquals(
    rotationRowConverged(applyRow({ status: 'skipped', error: CA_ROTATION_TARGET_GONE }), 'queued'),
    true
  )
})

test('rotationRowConverged blocks apply rows queued without commandId', () => {
  assertEquals(rotationRowConverged(applyRow(), 'queued'), false)
})

test('rotationRowConverged requires succeeded when commandId is set', () => {
  assertEquals(rotationRowConverged(applyRow({ commandId: COMMAND }), 'succeeded'), true)
  assertEquals(rotationRowConverged(applyRow({ commandId: COMMAND }), 'queued'), false)
})

test('rotationConvergedForRetire allows retire when only target_gone rows remain', () => {
  assertEquals(
    rotationConvergedForRetire(
      [
        applyRow({ status: 'skipped', error: CA_ROTATION_TARGET_GONE }),
        {
          serverId: SERVER,
          kind: 'ingress',
          status: 'skipped',
          error: CA_ROTATION_TARGET_GONE,
        },
      ],
      []
    ),
    true
  )
})

test('rotationConvergedForRetire blocks while a live apply row is still queued', () => {
  assertEquals(
    rotationConvergedForRetire(
      [applyRow({ commandId: COMMAND })],
      [{ id: COMMAND, status: 'queued' }],
      [{ managedId: MANAGED, serverId: SERVER }]
    ),
    false
  )
})

test('rotationConvergedForRetire blocks when a live cluster member has no journal apply row', () => {
  assertEquals(
    rotationConvergedForRetire(
      [applyRow({ commandId: PRIMARY_COMMAND })],
      [{ id: PRIMARY_COMMAND, status: 'succeeded' }],
      [
        { managedId: MANAGED, serverId: SERVER },
        { managedId: MANAGED, serverId: STANDBY_SERVER },
      ]
    ),
    false
  )
})

test('rotationConvergedForRetire blocks standby apply queued without commandId after primary succeeded', () => {
  assertEquals(
    rotationConvergedForRetire(
      [
        applyRow({ serverId: SERVER, commandId: PRIMARY_COMMAND }),
        applyRow({ serverId: STANDBY_SERVER, status: 'queued' }),
      ],
      [{ id: PRIMARY_COMMAND, status: 'succeeded' }],
      [
        { managedId: MANAGED, serverId: SERVER },
        { managedId: MANAGED, serverId: STANDBY_SERVER },
      ]
    ),
    false
  )
})

function tableName(value: unknown): string {
  try {
    return getTableName(value as never)
  } catch {
    return ''
  }
}

/** Host-free drizzle stub — real `Db` is wider than the methods under test. */
function asDb(stub: unknown): Db {
  return stub as unknown as Db
}

type ReconcileFixture = {
  organizationId?: string
  servers?: readonly string[]
  managed?: readonly string[]
  replicas?: readonly { managedId: string; serverId: string }[]
  commands?: readonly {
    id: string
    managedId: string
    serverId: string
    status: string
    error?: string | null
    errorCode?: string | null
  }[]
}

function drizzleSelectChain(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const terminal = {
    limit: () => promise,
    orderBy: () => terminal,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
  const chain = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => terminal,
    limit: () => promise,
    orderBy: () => terminal,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
  return chain
}

function createReconcileDb(fixture: ReconcileFixture = {}): Db {
  const organizationId = fixture.organizationId ?? ORG_ID
  const servers = fixture.servers ?? []
  const managed = fixture.managed ?? []
  const replicas = fixture.replicas ?? []
  const commands = fixture.commands ?? []

  return asDb({
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
    select: () => ({
      from: (table: unknown) => {
        const name = tableName(table)
        if (name === 'server') {
          return drizzleSelectChain(servers.map((id) => ({ id })))
        }
        if (name === 'managed') {
          return drizzleSelectChain(managed.map((id) => ({ id })))
        }
        if (name === 'replica') {
          return drizzleSelectChain(
            replicas.map((row) => ({
              managedId: row.managedId,
              serverId: row.serverId,
              serverOrganizationId: organizationId,
              workspaceOrganizationId: organizationId,
            }))
          )
        }
        if (name === 'command') {
          const rows = commands.map((row) => ({
            id: row.id,
            status: row.status,
            error: row.error ?? null,
            errorCode: row.errorCode ?? null,
          }))
          return drizzleSelectChain(rows)
        }
        return drizzleSelectChain([])
      },
    }),
  })
}

test('rotationApplyRowKey joins managed and server ids', () => {
  assertEquals(rotationApplyRowKey(MANAGED, SERVER), `${MANAGED}:${SERVER}`)
})

test('reconcileCaRotationResults skips ingress rows when the server is gone', async () => {
  const rows: CaRotationResultRow[] = [{ serverId: SERVER, kind: 'ingress', status: 'queued' }]
  const reconciled = await reconcileCaRotationResults(
    createReconcileDb({ servers: [] }),
    '00000000-0000-4000-8000-000000000099',
    rows,
    '2020-01-01T00:00:00.000Z'
  )
  assertEquals(reconciled[0]?.status, 'skipped')
  assertEquals(reconciled[0]?.error, CA_ROTATION_TARGET_GONE)
})

test('reconcileCaRotationResults skips apply rows when the managed cluster is gone', async () => {
  const rows: CaRotationResultRow[] = [
    {
      serverId: SERVER,
      kind: 'apply',
      managedId: MANAGED,
      status: 'queued',
    },
  ]
  const reconciled = await reconcileCaRotationResults(
    createReconcileDb({ servers: [SERVER] }),
    '00000000-0000-4000-8000-000000000099',
    rows,
    '2020-01-01T00:00:00.000Z'
  )
  assertEquals(reconciled[0]?.status, 'skipped')
  assertEquals(reconciled[0]?.error, CA_ROTATION_TARGET_GONE)
})

test('rotationRowConverged treats failed binding with target_gone as converged', () => {
  assertEquals(
    rotationRowConverged(
      {
        serverId: SERVER,
        kind: 'binding',
        managedId: MANAGED,
        status: 'failed',
        error: CA_ROTATION_TARGET_GONE,
      },
      'failed',
      CA_ROTATION_TARGET_GONE
    ),
    true
  )
})

test('enqueueMissingCaRotationApplies skips apply rows when the managed cluster is gone', async () => {
  const rows: CaRotationResultRow[] = []
  const result = await enqueueMissingCaRotationApplies(
    noopContext,
    createReconcileDb({
      organizationId: ORG_ID,
      servers: [SERVER],
      managed: [],
      replicas: [{ managedId: MANAGED, serverId: SERVER }],
    }),
    noopQueue,
    {
      organizationId: ORG_ID,
      actorId: '00000000-0000-4000-8000-000000000001',
      rows,
      rotationStartedAt: '2020-01-01T00:00:00.000Z',
    }
  )
  assertEquals(result.length, 1)
  assertEquals(result[0]?.status, 'skipped')
  assertEquals(result[0]?.error, CA_ROTATION_TARGET_GONE)
})

test('reconcileCaRotationResults skips binding rows when the managed cluster is gone', async () => {
  const rows: CaRotationResultRow[] = [
    {
      serverId: SERVER,
      kind: 'binding',
      managedId: MANAGED,
      status: 'queued',
    },
  ]
  const reconciled = await reconcileCaRotationResults(
    createReconcileDb({ servers: [SERVER], managed: [] }),
    '00000000-0000-4000-8000-000000000099',
    rows,
    '2020-01-01T00:00:00.000Z'
  )
  assertEquals(reconciled[0]?.status, 'skipped')
  assertEquals(reconciled[0]?.error, CA_ROTATION_TARGET_GONE)
})

test('reconcileCaRotationResults backfills apply command ids from managed.apply rows', async () => {
  const rows: CaRotationResultRow[] = [
    {
      serverId: SERVER,
      kind: 'apply',
      managedId: MANAGED,
      status: 'queued',
    },
  ]
  const reconciled = await reconcileCaRotationResults(
    createReconcileDb({
      servers: [SERVER],
      managed: [MANAGED],
      replicas: [{ managedId: MANAGED, serverId: SERVER }],
      commands: [
        {
          id: COMMAND,
          managedId: MANAGED,
          serverId: SERVER,
          status: 'queued',
        },
      ],
    }),
    '00000000-0000-4000-8000-000000000099',
    rows,
    '2020-01-01T00:00:00.000Z'
  )
  assertEquals(reconciled[0]?.commandId, COMMAND)
  assertEquals(reconciled[0]?.status, 'queued')
})

test('reconcileCaRotationResults marks apply rows skipped when command failed target_gone', async () => {
  const rows: CaRotationResultRow[] = [
    {
      serverId: SERVER,
      kind: 'apply',
      managedId: MANAGED,
      status: 'queued',
    },
  ]
  const reconciled = await reconcileCaRotationResults(
    createReconcileDb({
      servers: [SERVER],
      managed: [MANAGED],
      replicas: [{ managedId: MANAGED, serverId: SERVER }],
      commands: [
        {
          id: COMMAND,
          managedId: MANAGED,
          serverId: SERVER,
          status: 'failed',
          error: CA_ROTATION_TARGET_GONE,
        },
      ],
    }),
    '00000000-0000-4000-8000-000000000099',
    rows,
    '2020-01-01T00:00:00.000Z'
  )
  assertEquals(reconciled[0]?.status, 'skipped')
  assertEquals(reconciled[0]?.error, CA_ROTATION_TARGET_GONE)
})

test('reconcileCaRotationResults marks apply skipped when command errorCode is target_gone', async () => {
  const rows: CaRotationResultRow[] = [
    {
      serverId: SERVER,
      kind: 'apply',
      managedId: MANAGED,
      status: 'queued',
    },
  ]
  const reconciled = await reconcileCaRotationResults(
    createReconcileDb({
      servers: [SERVER],
      managed: [MANAGED],
      replicas: [{ managedId: MANAGED, serverId: SERVER }],
      commands: [
        {
          id: COMMAND,
          managedId: MANAGED,
          serverId: SERVER,
          status: 'failed',
          error: 'Managed cluster no longer exists',
          errorCode: CA_ROTATION_TARGET_GONE,
        },
      ],
    }),
    ORG_ID,
    rows,
    '2020-01-01T00:00:00.000Z'
  )
  assertEquals(reconciled[0]?.status, 'skipped')
  assertEquals(reconciled[0]?.error, CA_ROTATION_TARGET_GONE)
})

test('reconcileCaRotationResults treats journal managedId from another org as gone', async () => {
  const foreignManaged = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const rows: CaRotationResultRow[] = [
    {
      serverId: SERVER,
      kind: 'apply',
      managedId: foreignManaged,
      status: 'queued',
      commandId: COMMAND,
    },
  ]
  const reconciled = await reconcileCaRotationResults(
    createReconcileDb({
      organizationId: ORG_ID,
      servers: [SERVER],
      managed: [MANAGED],
      replicas: [{ managedId: MANAGED, serverId: SERVER }],
    }),
    ORG_ID,
    rows,
    '2020-01-01T00:00:00.000Z'
  )
  assertEquals(reconciled[0]?.status, 'skipped')
  assertEquals(reconciled[0]?.error, CA_ROTATION_TARGET_GONE)
})

test('rotationRowConverged rejects failed binding without target_gone', () => {
  assertEquals(
    rotationRowConverged(
      {
        serverId: SERVER,
        kind: 'binding',
        managedId: MANAGED,
        status: 'failed',
        error: 'other',
      },
      'failed',
      'other'
    ),
    false
  )
})

test('loadReconciledRotationWithCommandRecords skips gone ingress rows', async () => {
  const journal = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    startedAt: '2020-01-01T00:00:00.000Z',
    results: [{ serverId: SERVER, kind: 'ingress', status: 'queued' }],
  }
  const { rows, records } = await loadReconciledRotationWithCommandRecords(
    createReconcileDb({ servers: [] }),
    '00000000-0000-4000-8000-000000000099',
    journal
  )
  assertEquals(rows[0]?.status, 'skipped')
  assertEquals(rows[0]?.error, CA_ROTATION_TARGET_GONE)
  assertEquals(records.length, 0)
})

test('rotationResultReason explains deferred apply rows in plain words', () => {
  assertEquals(
    rotationResultReason({
      row: applyRow(),
      effectiveStatus: 'queued',
    }),
    'Waiting for a managed apply command to be enqueued for this cluster member.'
  )
  assertEquals(
    rotationResultReason({
      row: applyRow({ status: 'skipped', error: CA_ROTATION_TARGET_GONE }),
      effectiveStatus: 'skipped',
      effectiveError: CA_ROTATION_TARGET_GONE,
    }),
    'Skipped because the managed cluster, member, or server no longer exists.'
  )
  assertEquals(
    rotationResultReason({
      row: applyRow({ commandId: COMMAND }),
      effectiveStatus: 'running',
    }),
    'Waiting for the command to finish.'
  )
  assertEquals(
    rotationResultReason({
      row: applyRow({ commandId: COMMAND }),
      effectiveStatus: 'failed',
      effectiveError: 'apply exploded',
    }),
    'Failed: apply exploded'
  )
})
