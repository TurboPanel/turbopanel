import { assertEquals } from '@std/assert'
import { getTableName } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import type { CaRotationResultRow } from './changeover-fanout.ts'
import {
  CA_ROTATION_TARGET_GONE,
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
const MANAGED = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'
const COMMAND = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

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
      [{ id: COMMAND, status: 'queued' }]
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
  servers?: readonly string[]
  managed?: readonly string[]
  replicas?: readonly { managedId: string; serverId: string }[]
  commands?: readonly {
    id: string
    managedId: string
    serverId: string
    status: string
    error?: string | null
  }[]
}

function drizzleSelectChain(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  const afterOrderBy = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    limit: () => Promise.resolve(rows),
  }
  const chain = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    orderBy: () => afterOrderBy,
    then: (
      onFulfilled?: (value: unknown[]) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) => promise.then(onFulfilled, onRejected),
  }
  return chain
}

function createReconcileDb(fixture: ReconcileFixture = {}): Db {
  const servers = fixture.servers ?? []
  const managed = fixture.managed ?? []
  const replicas = fixture.replicas ?? []
  const commands = fixture.commands ?? []

  return asDb({
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
            replicas.map((row) => ({ managedId: row.managedId, serverId: row.serverId }))
          )
        }
        if (name === 'command') {
          const rows = commands.map((row) => ({
            id: row.id,
            status: row.status,
            error: row.error ?? null,
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
