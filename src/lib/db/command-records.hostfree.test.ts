/**
 * Host-free coverage for command record CRUD + transition (no Postgres).
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  createCommandRecord,
  getCommandMetadata,
  getCommandRecord,
  listServerCommands,
  serializeCommandRecord,
  transitionCommand,
} from './command-records.ts'

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
  payload: { ping: true },
  result: null as unknown,
  metadata: {
    queuedAt: '2020-01-01T00:00:00.000Z',
  } as Record<string, unknown> | null,
}

test('createCommandRecord serializes the inserted row', async () => {
  let inserted: unknown
  const db = {
    insert: () => ({
      values: (values: unknown) => {
        inserted = values
        return {
          returning: () => Promise.resolve([{ ...baseRow, ...values as object }]),
        }
      },
    }),
  } as unknown as Db

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
  assertEquals((inserted as { status: string }).status, 'queued')
  assertEquals(
    ((inserted as { metadata: { expiresAt: string } }).metadata).expiresAt,
    '2020-01-01T00:01:00.000Z',
  )
  assertEquals(
    ((inserted as { metadata: { followUp: boolean } }).metadata).followUp,
    true,
  )
})

test('createCommandRecord throws when insert returns nothing', async () => {
  const db = {
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db
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

test('transitionCommand patches status timestamps and returns null when missing', async () => {
  let setPayload: unknown
  const db = {
    update: () => ({
      set: (patch: unknown) => {
        setPayload = patch
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...baseRow,
                  status: 'failed',
                  metadata: {
                    error: 'Command queue unavailable',
                    finishedAt: '2020-01-01T00:00:02.000Z',
                  },
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
    attempts: 2,
    result: { ok: false },
  })
  assertEquals(failed?.status, 'failed')
  assertEquals(failed?.error, 'Command queue unavailable')
  assertEquals((setPayload as { attempts: number }).attempts, 2)

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
    result: undefined as unknown as null,
    metadata: {},
  } as never)
  assertEquals(record.status, 'queued')
  assertEquals(record.attempts, 0)
  assertEquals(record.result, null)
})
