/**
 * Host-free coverage for command record CRUD + transition (no Postgres).
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  createCommandRecord,
  deleteCommandDispatch,
  getCommandDispatchPayload,
  getCommandMetadata,
  getCommandRecord,
  listCommandRecordsByIds,
  listServerCommands,
  retainCommandDispatch,
  serializeCommandRecord,
  sweepExpiredCommandDispatch,
  transitionCommand,
} from './command-records.ts'
import type { CommandStatus } from '../commands/types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const baseRow = {
  id: '00000000-0000-4000-8000-000000000010',
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:01.000Z',
  serverId: '00000000-0000-4000-8000-000000000011',
  actorType: 'user',
  actorId: '00000000-0000-4000-8000-000000000012',
  name: 'daemon.ping',
  status: 'queued',
  attempts: 0,
  context: null as unknown,
  resultSummary: null as unknown,
  errorCode: null as string | null,
  errorMessage: null as string | null,
  queuedAt: '2020-01-01T00:00:00.000Z' as string | null,
  dispatchStartedAt: null as string | null,
  sentAt: null as string | null,
  ackedAt: null as string | null,
  startedAt: null as string | null,
  finishedAt: null as string | null,
  expiresAt: null as string | null,
}

/** Fake `db.transaction` exposing the two inserts `createCommandRecord` makes. */
function fakeInsertDb(options: {
  commandRows: unknown[]
  onCommandValues?: (values: unknown) => void
  onDispatchValues?: (values: unknown) => void
}): Db {
  let call = 0
  const tx = {
    insert: () => {
      call += 1
      const isCommand = call === 1
      return {
        values: (values: unknown) => {
          if (isCommand) {
            options.onCommandValues?.(values)
            return {
              returning: () =>
                Promise.resolve(
                  options.commandRows.map((row) => ({
                    ...(row as object),
                    ...(values as object),
                  })),
                ),
            }
          }
          options.onDispatchValues?.(values)
          return Promise.resolve(undefined)
        },
      }
    },
  }
  return {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db
}

test('createCommandRecord writes the command row and its dispatch payload', async () => {
  let commandValues: unknown
  let dispatchValues: unknown
  const db = fakeInsertDb({
    commandRows: [baseRow],
    onCommandValues: (v) => {
      commandValues = v
    },
    onDispatchValues: (v) => {
      dispatchValues = v
    },
  })

  const record = await createCommandRecord(db, {
    serverId: baseRow.serverId,
    actorType: 'user',
    actorId: baseRow.actorId,
    type: 'daemon.ping',
    payload: { ping: true },
    expiresAt: '2020-01-01T00:01:00.000Z',
    metadata: { followUp: true },
  })

  assertEquals(record.type, 'daemon.ping')
  assertEquals(record.actorEntityType, 'user')
  assertEquals((commandValues as { status: string }).status, 'queued')
  // Lifecycle + expiry are real columns now, not metadata keys.
  assertEquals(
    (commandValues as { expiresAt: string }).expiresAt,
    '2020-01-01T00:01:00.000Z',
  )
  assertEquals((commandValues as { queuedAt?: string }).queuedAt !== undefined, true)
  assertEquals(
    (commandValues as { metadata: { followUp: boolean } }).metadata.followUp,
    true,
  )
  // Payload never touches the `command` row.
  assertEquals(Object.hasOwn(commandValues as object, 'payload'), false)
  assertEquals((dispatchValues as { payload: unknown }).payload, { ping: true })
  assertEquals(
    (dispatchValues as { commandId: string }).commandId,
    baseRow.id,
  )
})

test('createCommandRecord derives context from payload identifiers', async () => {
  let commandValues: unknown
  const db = fakeInsertDb({
    commandRows: [baseRow],
    onCommandValues: (v) => {
      commandValues = v
    },
  })

  await createCommandRecord(db, {
    serverId: baseRow.serverId,
    actorType: 'user',
    actorId: baseRow.actorId,
    type: 'managed.apply',
    payload: {
      managedId: 'm1',
      memberRole: 'primary',
      credentials: { password: 'secret' },
    },
  })

  assertEquals((commandValues as { context: unknown }).context, {
    managedId: 'm1',
    memberRole: 'primary',
  })
})

test('createCommandRecord honors an explicit context', async () => {
  let commandValues: unknown
  const db = fakeInsertDb({
    commandRows: [baseRow],
    onCommandValues: (v) => {
      commandValues = v
    },
  })

  await createCommandRecord(db, {
    serverId: baseRow.serverId,
    actorType: 'user',
    actorId: baseRow.actorId,
    type: 'daemon.ping',
    payload: { managedId: 'ignored' },
    context: { environmentId: 'e1' },
  })

  assertEquals((commandValues as { context: unknown }).context, {
    environmentId: 'e1',
  })
})

test('createCommandRecord throws when insert returns nothing', async () => {
  const db = fakeInsertDb({ commandRows: [] })
  await assertRejects(
    () =>
      createCommandRecord(db, {
        serverId: 's',
        actorType: 'user',
        actorId: 'a',
        type: 'daemon.ping',
        payload: {},
      }),
    Error,
    'Failed to create command record',
  )
})

test('getCommandMetadata and getCommandRecord empty paths', async () => {
  const empty = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getCommandMetadata(empty, 'missing'), null)
  assertEquals(await getCommandRecord(empty, 'missing'), null)

  const arrMeta = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ metadata: [1, 2] }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getCommandMetadata(arrMeta, 'id'), null)

  const good = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([{ metadata: { chain: 'next' } }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getCommandMetadata(good, 'id'), { chain: 'next' })

  const rowDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([baseRow]),
        }),
      }),
    }),
  } as unknown as Db
  const rec = await getCommandRecord(rowDb, baseRow.id)
  assertEquals(rec?.id, baseRow.id)
  assertEquals(Object.hasOwn(rec as object, 'payload'), false)
})

test('command reads select an explicit column list, never a dispatch join', async () => {
  const source = await Deno.readTextFile(
    new URL('./command-records.ts', import.meta.url),
  )
  // A bare `.select()` would return every column of whatever is joined in.
  assertEquals(source.includes('.select()'), false)
  // Dispatch payload is reachable from exactly one query.
  assertEquals(
    source.split('.select({ payload: dispatch.payload })').length - 1,
    1,
  )
  assertEquals(source.includes('.innerJoin('), false)
  assertEquals(source.includes('.leftJoin('), false)
})

test('getCommandDispatchPayload returns the payload or null', async () => {
  const found = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ payload: { ping: true } }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getCommandDispatchPayload(found, baseRow.id), {
    ping: true,
  })

  const missing = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getCommandDispatchPayload(missing, baseRow.id), null)
})

test('deleteCommandDispatch and retainCommandDispatch target one command', async () => {
  let deleted = 0
  const delDb = {
    delete: () => ({
      where: () => {
        deleted += 1
        return Promise.resolve(undefined)
      },
    }),
  } as unknown as Db
  await deleteCommandDispatch(delDb, baseRow.id)
  // Idempotent: a second call is just another no-op delete.
  await deleteCommandDispatch(delDb, baseRow.id)
  assertEquals(deleted, 2)

  let patch: unknown
  const updDb = {
    update: () => ({
      set: (values: unknown) => {
        patch = values
        return { where: () => Promise.resolve(undefined) }
      },
    }),
  } as unknown as Db
  await retainCommandDispatch(updDb, baseRow.id, '2030-01-01T00:00:00.000Z')
  assertEquals(patch, { expiresAt: '2030-01-01T00:00:00.000Z' })
})

test('sweepExpiredCommandDispatch clamps the limit and counts deletions', async () => {
  const makeDb = (rows: unknown[]) =>
    ({
      delete: () => ({
        where: () => ({
          returning: () => Promise.resolve(rows),
        }),
      }),
    }) as unknown as Db

  assertEquals(
    await sweepExpiredCommandDispatch(makeDb([{ commandId: 'a' }]), {
      limit: 10,
    }),
    1,
  )
  assertEquals(
    await sweepExpiredCommandDispatch(makeDb([]), { limit: 0 }),
    0,
  )
  assertEquals(
    await sweepExpiredCommandDispatch(makeDb([]), {
      limit: 100_000,
      now: '2020-01-01T00:00:00.000Z',
    }),
    0,
  )
})

test('listServerCommands clamps limit and maps rows', async () => {
  let capturedLimit: number | undefined
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => {
              capturedLimit = n
              return Promise.resolve([baseRow])
            },
          }),
        }),
      }),
    }),
  } as unknown as Db

  const rows = await listServerCommands(db, {
    serverId: baseRow.serverId,
    limit: 500,
  })
  assertEquals(capturedLimit, 100)
  assertEquals(rows.length, 1)

  await listServerCommands(db, { serverId: baseRow.serverId, limit: 0 })
  assertEquals(capturedLimit, 1)

  await listServerCommands(db, { serverId: baseRow.serverId })
  assertEquals(capturedLimit, 20)
})

test('transitionCommand patches columns and returns null when missing', async () => {
  let setPayload: unknown
  const db = {
    delete: () => ({ where: () => Promise.resolve(undefined) }),
    update: () => ({
      set: (patch: unknown) => {
        // Ignore the dispatch-retention update that follows a terminal status.
        if ((patch as { status?: unknown }).status !== undefined) setPayload = patch
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...baseRow,
                  status: 'failed',
                  errorMessage: 'Command queue unavailable',
                  finishedAt: '2020-01-01T00:00:02.000Z',
                },
              ]),
          }),
        }
      },
    }),
  } as unknown as Db

  const failed = await transitionCommand(db, baseRow.id, {
    status: 'failed',
    error: 'Command queue unavailable',
    errorCode: 'queue_unavailable',
    attempts: 2,
    result: { ok: false },
  })
  assertEquals(failed?.status, 'failed')
  assertEquals(failed?.error, 'Command queue unavailable')
  assertEquals(failed?.errorMessage, 'Command queue unavailable')
  const patch = setPayload as {
    attempts: number
    errorMessage: string
    errorCode: string
    resultSummary: unknown
    finishedAt?: string
  }
  assertEquals(patch.attempts, 2)
  assertEquals(patch.errorMessage, 'Command queue unavailable')
  assertEquals(patch.errorCode, 'queue_unavailable')
  assertEquals(patch.resultSummary, { ok: false })
  assertEquals(typeof patch.finishedAt, 'string')
  // Lifecycle no longer round-trips through the metadata jsonb blob.
  assertEquals(Object.hasOwn(patch, 'metadata'), false)

  const missing = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(
    await transitionCommand(missing, 'gone', { status: 'succeeded' }),
    null,
  )
})

test('serializeCommandRecord still coerces sparse rows', () => {
  const record = serializeCommandRecord({
    ...baseRow,
    status: null as unknown as string,
    attempts: null as unknown as number,
    resultSummary: undefined as unknown as null,
  } as never)
  assertEquals(record.status, 'queued')
  assertEquals(record.attempts, 0)
  assertEquals(record.result, null)
  assertEquals(record.context, null)
})

test('serializeCommandRecord maps the full lifecycle column set', () => {
  const record = serializeCommandRecord({
    ...baseRow,
    status: 'acked',
    attempts: 2,
    resultSummary: { ok: true },
    context: { environmentId: 'e1' },
    queuedAt: '2020-01-01T00:00:00.000Z',
    dispatchStartedAt: '2020-01-01T00:00:00.010Z',
    sentAt: '2020-01-01T00:00:00.020Z',
    ackedAt: '2020-01-01T00:00:00.030Z',
    startedAt: '2020-01-01T00:00:00.040Z',
    finishedAt: null,
    expiresAt: '2020-01-01T00:01:00.000Z',
  } as never)

  assertEquals(record.status, 'acked')
  assertEquals(record.attempts, 2)
  assertEquals(record.result, { ok: true })
  assertEquals(record.context, { environmentId: 'e1' })
  assertEquals(record.queuedAt, '2020-01-01T00:00:00.000Z')
  assertEquals(record.dispatchStartedAt, '2020-01-01T00:00:00.010Z')
  assertEquals(record.sentAt, '2020-01-01T00:00:00.020Z')
  assertEquals(record.ackedAt, '2020-01-01T00:00:00.030Z')
  assertEquals(record.startedAt, '2020-01-01T00:00:00.040Z')
  assertEquals(record.finishedAt, null)
  assertEquals(record.expiresAt, '2020-01-01T00:01:00.000Z')
  assertEquals(record.error, null)
  assertEquals(record.errorMessage, null)
})

test('serializeCommandRecord normalizes postgres.js timestamptz strings to ISO-8601', () => {
  const record = serializeCommandRecord({
    ...baseRow,
    createdAt: '2020-01-01 00:00:00+00',
    updatedAt: new Date('2020-01-01T00:00:01.000Z'),
    queuedAt: new Date('not-a-timestamp'),
    ackedAt: '2020-01-01 00:00:00.15+00',
    finishedAt: '2020-01-01 00:00:00.25+00',
    expiresAt: 'not-a-timestamp',
  } as never)

  assertEquals(record.createdAt, '2020-01-01T00:00:00.000Z')
  assertEquals(record.updatedAt, '2020-01-01T00:00:01.000Z')
  assertEquals(record.queuedAt, null)
  assertEquals(record.ackedAt, '2020-01-01T00:00:00.150Z')
  assertEquals(record.finishedAt, '2020-01-01T00:00:00.250Z')
  assertEquals(record.expiresAt, 'not-a-timestamp')
})

test('listCommandRecordsByIds returns empty for no ids and maps matches', async () => {
  assertEquals(await listCommandRecordsByIds({} as Db, []), [])

  let capturedIds: string[] | undefined
  const db = {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => {
          capturedIds = args as string[]
          return Promise.resolve([baseRow])
        },
      }),
    }),
  } as unknown as Db

  const rows = await listCommandRecordsByIds(db, [baseRow.id])
  assertEquals(rows.length, 1)
  assertEquals(rows[0]?.id, baseRow.id)
  assertEquals(capturedIds !== undefined, true)
})

test('transitionCommand auto-stamps the status timestamp when omitted', async () => {
  const cases: Array<{ status: CommandStatus; field: string }> = [
    { status: 'queued', field: 'queuedAt' },
    { status: 'dispatching', field: 'dispatchStartedAt' },
    { status: 'sent', field: 'sentAt' },
    { status: 'acked', field: 'ackedAt' },
    { status: 'running', field: 'startedAt' },
    { status: 'succeeded', field: 'finishedAt' },
    { status: 'timed_out', field: 'finishedAt' },
    { status: 'cancelled', field: 'finishedAt' },
  ]

  for (const { status, field } of cases) {
    let patch: Record<string, unknown> | undefined
    const db = {
      delete: () => ({ where: () => Promise.resolve(undefined) }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          if (values.status !== undefined) patch = values
          return {
            where: () => ({
              returning: () =>
                Promise.resolve([
                  { ...baseRow, status, [field]: '2020-01-01T00:00:09.000Z' },
                ]),
            }),
          }
        },
      }),
    } as unknown as Db

    const record = await transitionCommand(db, baseRow.id, { status })
    assertEquals(record?.status, status)
    assertEquals(typeof patch?.[field], 'string')
  }
})

test('transitionCommand keeps an explicit lifecycle timestamp over the auto-stamp', async () => {
  let patch: Record<string, unknown> | undefined
  const db = {
    delete: () => ({ where: () => Promise.resolve(undefined) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        if (values.status !== undefined) patch = values
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...baseRow,
                  status: 'sent',
                  sentAt: '2020-01-01T00:00:05.000Z',
                },
              ]),
          }),
        }
      },
    }),
  } as unknown as Db

  const record = await transitionCommand(db, baseRow.id, {
    status: 'sent',
    sentAt: '2020-01-01T00:00:05.000Z',
  })
  assertEquals(record?.sentAt, '2020-01-01T00:00:05.000Z')
  assertEquals(patch?.sentAt, '2020-01-01T00:00:05.000Z')
})
