import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { command, dispatch, organization, server } from './schema.ts'
import {
  createCommandRecord,
  deleteCommandDispatch,
  getCommandDispatchPayload,
  getCommandRecord,
  listServerCommands,
  retainCommandDispatch,
  serializeCommandRecord,
  sweepExpiredCommandDispatch,
  transitionCommand,
} from './command-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

test('serializeCommandRecord maps lifecycle columns and never exposes payload', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000010',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:01.000Z',
    serverId: '00000000-0000-4000-8000-000000000011',
    actorType: 'user',
    actorId: '00000000-0000-4000-8000-000000000012',
    name: 'daemon.ping',
    status: 'succeeded',
    attempts: 1,
    context: { environmentId: '00000000-0000-4000-8000-0000000000ee' },
    resultSummary: { daemonHostname: 'web-01' },
    errorCode: null,
    errorMessage: null,
    queuedAt: '2020-01-01T00:00:00.000Z',
    dispatchStartedAt: '2020-01-01T00:00:00.100Z',
    sentAt: '2020-01-01T00:00:00.200Z',
    ackedAt: '2020-01-01T00:00:00.300Z',
    startedAt: '2020-01-01T00:00:00.300Z',
    finishedAt: '2020-01-01T00:00:00.400Z',
    expiresAt: '2020-01-01T00:01:00.000Z',
  }

  const record = serializeCommandRecord(row)
  assertEquals(record.id, row.id)
  assertEquals(record.serverId, row.serverId)
  assertEquals(record.actorEntityType, 'user')
  assertEquals(record.actorEntityId, row.actorId)
  assertEquals(record.type, 'daemon.ping')
  assertEquals(record.status, 'succeeded')
  assertEquals(record.result, { daemonHostname: 'web-01' })
  assertEquals(record.context, {
    environmentId: '00000000-0000-4000-8000-0000000000ee',
  })
  assertEquals(record.error, null)
  assertEquals(record.errorCode, null)
  assertEquals(record.attempts, 1)
  assertEquals(record.queuedAt, '2020-01-01T00:00:00.000Z')
  assertEquals(record.dispatchStartedAt, '2020-01-01T00:00:00.100Z')
  assertEquals(record.finishedAt, '2020-01-01T00:00:00.400Z')
  assertEquals(record.expiresAt, '2020-01-01T00:01:00.000Z')
  // The daemon execution payload lives in `dispatch` only.
  assertEquals(Object.hasOwn(record, 'payload'), false)
})

test('serializeCommandRecord normalizes postgres.js timestamptz strings to ISO-8601', () => {
  const record = serializeCommandRecord({
    id: '00000000-0000-4000-8000-000000000010',
    createdAt: '2020-01-01 00:00:00+00',
    updatedAt: '2020-01-01 00:00:01+00',
    serverId: '00000000-0000-4000-8000-000000000011',
    actorType: 'user',
    actorId: '00000000-0000-4000-8000-000000000012',
    name: 'daemon.ping',
    status: 'succeeded',
    attempts: 1,
    context: null,
    resultSummary: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: '2030-01-01 00:00:00+00',
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: '2020-01-01 00:00:00.15+00',
    startedAt: null,
    finishedAt: '2020-01-01 00:00:00.25+00',
    expiresAt: '2030-01-01 00:00:00+00',
  })

  assertEquals(record.createdAt, '2020-01-01T00:00:00.000Z')
  assertEquals(record.queuedAt, '2030-01-01T00:00:00.000Z')
  assertEquals(record.ackedAt, '2020-01-01T00:00:00.150Z')
  assertEquals(record.finishedAt, '2020-01-01T00:00:00.250Z')
  assertEquals(record.expiresAt, '2030-01-01T00:00:00.000Z')
})

test('serializeCommandRecord defaults missing lifecycle columns to nulls', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000020',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    serverId: '00000000-0000-4000-8000-000000000021',
    actorType: 'system',
    actorId: '00000000-0000-4000-8000-000000000022',
    name: 'system.reconcile',
    status: 'queued',
    attempts: 0,
    context: null,
    resultSummary: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: null,
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
  }

  const record = serializeCommandRecord(row)
  assertEquals(record.status, 'queued')
  assertEquals(record.result, null)
  assertEquals(record.context, null)
  assertEquals(record.error, null)
  assertEquals(record.queuedAt, null)
  assertEquals(record.expiresAt, null)
})

async function withCommandRecordFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping command-records DB tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Command Records Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Command Records Server',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, serverId })
  } finally {
    // `dispatch` rows cascade with their command row.
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('createCommandRecord inserts queued row plus its dispatch payload', async () => {
  await withCommandRecordFixtures(async ({ db, serverId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      type: 'daemon.ping',
      payload: {},
      expiresAt: '2030-01-01T00:00:00.000Z',
    })

    assertEquals(record.status, 'queued')
    assertEquals(record.type, 'daemon.ping')
    assertEquals(record.attempts, 0)
    assertEquals(record.queuedAt !== null, true)
    assertEquals(record.expiresAt, '2030-01-01T00:00:00.000Z')

    const loaded = await getCommandRecord(db, record.id)
    assertEquals(loaded?.id, record.id)
    assertEquals(loaded?.status, 'queued')

    // Payload landed in `dispatch`, in the same transaction.
    assertEquals(await getCommandDispatchPayload(db, record.id), {})
  })
})

test('createCommandRecord derives a non-secret context from the payload', async () => {
  await withCommandRecordFixtures(async ({ db, serverId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      type: 'managed.apply',
      payload: {
        managedId: '00000000-0000-4000-8000-0000000000aa',
        memberRole: 'primary',
        composeYaml: 'services: {}',
      },
    })

    assertEquals(record.context, {
      managedId: '00000000-0000-4000-8000-0000000000aa',
      memberRole: 'primary',
    })
  })
})

test('getCommandDispatchPayload round-trips and deleteCommandDispatch is idempotent', async () => {
  await withCommandRecordFixtures(async ({ db, serverId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      type: 'daemon.ping',
      payload: { secretish: 'value' },
    })

    assertEquals(await getCommandDispatchPayload(db, record.id), {
      secretish: 'value',
    })

    await deleteCommandDispatch(db, record.id)
    assertEquals(await getCommandDispatchPayload(db, record.id), null)
    // Second delete is a no-op, not an error.
    await deleteCommandDispatch(db, record.id)
    assertEquals(await getCommandDispatchPayload(db, record.id), null)
  })
})

test('sweepExpiredCommandDispatch deletes only expired rows, bounded by limit', async () => {
  await withCommandRecordFixtures(async ({ db, serverId }) => {
    const make = async (n: number) =>
      await createCommandRecord(db, {
        serverId,
        actorType: 'user',
        actorId: '00000000-0000-4000-8000-000000000001',
        type: 'daemon.ping',
        payload: { n },
      })

    const expiredA = await make(1)
    const expiredB = await make(2)
    const retained = await make(3)
    const untouched = await make(4)

    await retainCommandDispatch(db, expiredA.id, '2020-01-01T00:00:00.000Z')
    await retainCommandDispatch(db, expiredB.id, '2020-01-01T00:00:01.000Z')
    await retainCommandDispatch(db, retained.id, '2999-01-01T00:00:00.000Z')

    // Bounded: only the oldest expired row goes on this tick.
    assertEquals(await sweepExpiredCommandDispatch(db, { limit: 1 }), 1)
    assertEquals(await getCommandDispatchPayload(db, expiredA.id), null)
    assertEquals(await getCommandDispatchPayload(db, expiredB.id), { n: 2 })

    assertEquals(await sweepExpiredCommandDispatch(db, { limit: 100 }), 1)
    assertEquals(await getCommandDispatchPayload(db, expiredB.id), null)

    // Future `expires_at` and never-stamped rows survive.
    assertEquals(await getCommandDispatchPayload(db, retained.id), { n: 3 })
    assertEquals(await getCommandDispatchPayload(db, untouched.id), { n: 4 })

    await db.delete(dispatch).where(eq(dispatch.commandId, retained.id))
  })
})

test('transitionCommand writes lifecycle columns and auto-stamps status timestamps', async () => {
  await withCommandRecordFixtures(async ({ db, serverId }) => {
    const created = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      type: 'daemon.ping',
      payload: {},
    })

    const dispatching = await transitionCommand(db, created.id, {
      status: 'dispatching',
      attempts: 1,
    })
    assertEquals(dispatching?.status, 'dispatching')
    assertEquals(dispatching?.attempts, 1)
    assertEquals(dispatching?.dispatchStartedAt !== null, true)

    const succeeded = await transitionCommand(db, created.id, {
      status: 'succeeded',
      result: { daemonHostname: 'web-01' },
      ackedAt: '2020-01-01T00:00:00.150Z',
      finishedAt: '2020-01-01T00:00:00.250Z',
    })
    assertEquals(succeeded?.status, 'succeeded')
    assertEquals(
      (succeeded?.result as { daemonHostname?: string }).daemonHostname,
      'web-01',
    )
    assertEquals(succeeded?.ackedAt, '2020-01-01T00:00:00.150Z')
    assertEquals(succeeded?.finishedAt, '2020-01-01T00:00:00.250Z')
  })
})

test('transitionCommand stores terminal errors in error columns', async () => {
  await withCommandRecordFixtures(async ({ db, serverId }) => {
    const created = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      type: 'daemon.ping',
      payload: {},
    })

    const failed = await transitionCommand(db, created.id, {
      status: 'failed',
      error: 'Daemon not connected',
      errorCode: 'daemon_offline',
    })
    assertEquals(failed?.status, 'failed')
    assertEquals(failed?.error, 'Daemon not connected')
    assertEquals(failed?.errorMessage, 'Daemon not connected')
    assertEquals(failed?.errorCode, 'daemon_offline')
    assertEquals(failed?.finishedAt !== null, true)
  })
})

test('listServerCommands returns newest-first rows with clamped limit', async () => {
  await withCommandRecordFixtures(async ({ db, serverId }) => {
    const first = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      type: 'daemon.ping',
      payload: { n: 1 },
    })
    const second = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      type: 'daemon.ping',
      payload: { n: 2 },
    })

    const listed = await listServerCommands(db, { serverId, limit: 1 })
    assertEquals(listed.length, 1)
    assertEquals(listed[0]!.id, second.id)

    const all = await listServerCommands(db, { serverId, limit: 1000 })
    assertEquals(all.length, 2)
    assertEquals(all[0]!.id, second.id)
    assertEquals(all[1]!.id, first.id)
  })
})

test('getCommandRecord returns null for unknown id', async () => {
  await withCommandRecordFixtures(async ({ db }) => {
    const missing = await getCommandRecord(
      db,
      '00000000-0000-4000-8000-000000000099',
    )
    assertEquals(missing, null)
  })
})

test('transitionCommand returns null for unknown id', async () => {
  await withCommandRecordFixtures(async ({ db }) => {
    const updated = await transitionCommand(
      db,
      '00000000-0000-4000-8000-000000000099',
      { status: 'failed', error: 'missing' },
    )
    assertEquals(updated, null)
  })
})
