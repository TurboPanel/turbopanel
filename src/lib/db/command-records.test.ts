import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { command, organization, server } from './schema.ts'
import {
  createCommandRecord,
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

const dbUrl = getDatabaseUrl()

test('serializeCommandRecord flattens column and metadata fields', () => {
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
    payload: { ping: true },
    result: { daemonHostname: 'web-01' },
    metadata: {
      error: null,
      queuedAt: '2020-01-01T00:00:00.000Z',
      dispatchStartedAt: '2020-01-01T00:00:00.100Z',
      sentAt: '2020-01-01T00:00:00.200Z',
      ackedAt: '2020-01-01T00:00:00.300Z',
      startedAt: '2020-01-01T00:00:00.300Z',
      finishedAt: '2020-01-01T00:00:00.400Z',
      expiresAt: '2020-01-01T00:01:00.000Z',
    },
  }

  const record = serializeCommandRecord(row)
  assertEquals(record.id, row.id)
  assertEquals(record.serverId, row.serverId)
  assertEquals(record.actorEntityType, 'user')
  assertEquals(record.actorEntityId, row.actorId)
  assertEquals(record.type, 'daemon.ping')
  assertEquals(record.status, 'succeeded')
  assertEquals(record.payload, { ping: true })
  assertEquals(record.result, { daemonHostname: 'web-01' })
  assertEquals(record.error, null)
  assertEquals(record.attempts, 1)
  assertEquals(record.queuedAt, '2020-01-01T00:00:00.000Z')
  assertEquals(record.dispatchStartedAt, '2020-01-01T00:00:00.100Z')
  assertEquals(record.finishedAt, '2020-01-01T00:00:00.400Z')
  assertEquals(record.expiresAt, '2020-01-01T00:01:00.000Z')
})

test('serializeCommandRecord defaults missing metadata to nulls', () => {
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
    payload: {},
    result: null,
    metadata: null,
  }

  const record = serializeCommandRecord(row)
  assertEquals(record.status, 'queued')
  assertEquals(record.result, null)
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
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('createCommandRecord inserts queued row with lifecycle metadata', async () => {
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
  })
})

test('transitionCommand merges metadata and auto-stamps status timestamps', async () => {
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

test('transitionCommand stores terminal errors in metadata', async () => {
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
    })
    assertEquals(failed?.status, 'failed')
    assertEquals(failed?.error, 'Daemon not connected')
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
