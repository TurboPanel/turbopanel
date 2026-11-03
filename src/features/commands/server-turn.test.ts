import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { command, organization, server } from '../../db/schema.ts'
import { createCommandRecord, getCommandRecord, transitionCommand } from './command-records.ts'
import { claimServerTurn } from './server-turn.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Ctx = { db: ReturnType<typeof createDenoDb>; serverId: string; otherServerId: string }

async function withServers(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('server-turn DB tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Server Turn Test Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const now = new Date().toISOString()
  const [first, second] = await db
    .insert(server)
    .values([
      { organizationId, name: 'Server Turn A', createdAt: now, updatedAt: now },
      { organizationId, name: 'Server Turn B', createdAt: now, updatedAt: now },
    ])
    .returning({ id: server.id })
  try {
    await fn({ db, serverId: first!.id, otherServerId: second!.id })
  } finally {
    await db.delete(command).where(eq(command.serverId, first!.id))
    await db.delete(command).where(eq(command.serverId, second!.id))
    await db.delete(server).where(eq(server.id, first!.id))
    await db.delete(server).where(eq(server.id, second!.id))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

function newCommand(db: Ctx['db'], serverId: string, type: 'daemon.ping' | 'environment.deploy') {
  return createCommandRecord(db, {
    serverId,
    actorType: 'user',
    actorId: '00000000-0000-4000-8000-000000000001',
    type,
    payload: {},
    expiresAt: '2030-01-01T00:00:00.000Z',
  })
}

function claim(db: Ctx['db'], record: { id: string; serverId: string; attempts: number }) {
  return claimServerTurn(db, {
    commandId: record.id,
    serverId: record.serverId,
    attempts: record.attempts,
  })
}

test('the first command of an idle server takes its turn and is marked dispatching', async () => {
  await withServers(async ({ db, serverId }) => {
    const record = await newCommand(db, serverId, 'daemon.ping')
    assertEquals(await claim(db, record), 'claimed')
    const loaded = await getCommandRecord(db, record.id)
    assertEquals(loaded?.status, 'dispatching')
    assertEquals(loaded?.attempts, 1)
    assertEquals(loaded?.dispatchStartedAt !== null, true)
  })
})

test('a command waits while another command of the same server runs', async () => {
  await withServers(async ({ db, serverId, otherServerId }) => {
    const running = await newCommand(db, serverId, 'daemon.ping')
    await transitionCommand(db, running.id, { status: 'sent' })
    const next = await newCommand(db, serverId, 'daemon.ping')
    assertEquals(await claim(db, next), 'busy')
    assertEquals((await getCommandRecord(db, next.id))?.status, 'queued')
    // Another server is not held up.
    const elsewhere = await newCommand(db, otherServerId, 'daemon.ping')
    assertEquals(await claim(db, elsewhere), 'claimed')
    // Once the running one ends, the next one goes.
    await transitionCommand(db, running.id, { status: 'succeeded' })
    assertEquals(await claim(db, next), 'claimed')
  })
})

test('a newer command waits for an older one of the same server that has not started', async () => {
  await withServers(async ({ db, serverId }) => {
    const older = await newCommand(db, serverId, 'daemon.ping')
    const newer = await newCommand(db, serverId, 'daemon.ping')
    assertEquals(await claim(db, newer), 'busy')
    assertEquals(await claim(db, older), 'claimed')
  })
})

test('an older queued command whose message was lost stops holding the server after the wait limit', async () => {
  await withServers(async ({ db, serverId }) => {
    const older = await newCommand(db, serverId, 'daemon.ping')
    await db
      .update(command)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(command.id, older.id))
    const newer = await newCommand(db, serverId, 'daemon.ping')
    assertEquals(await claim(db, newer), 'claimed')
  })
})

test('a deploy the server has taken over no longer holds the turn', async () => {
  await withServers(async ({ db, serverId }) => {
    const deploy = await newCommand(db, serverId, 'environment.deploy')
    await transitionCommand(db, deploy.id, { status: 'sent' })
    const next = await newCommand(db, serverId, 'daemon.ping')
    assertEquals(await claim(db, next), 'busy')
    await db
      .update(command)
      .set({
        progress: {
          version: 1,
          steps: [],
          current: null,
          updatedAt: new Date().toISOString(),
          runningSince: new Date().toISOString(),
        },
      })
      .where(eq(command.id, deploy.id))
    assertEquals(await claim(db, next), 'claimed')
  })
})

test('a command that finished meanwhile is not started', async () => {
  await withServers(async ({ db, serverId }) => {
    const record = await newCommand(db, serverId, 'daemon.ping')
    await transitionCommand(db, record.id, { status: 'cancelled' })
    assertEquals(await claim(db, record), 'finished')
    assertEquals((await getCommandRecord(db, record.id))?.status, 'cancelled')
  })
})

test('two consumers checking the same server at the same instant start only one command', async () => {
  await withServers(async ({ db, serverId }) => {
    // Neither waits for the other by order (the older one is past the wait
    // limit), so only the row lock keeps them apart.
    const first = await newCommand(db, serverId, 'daemon.ping')
    await db
      .update(command)
      .set({ createdAt: sql`now() - interval '10 minutes'` })
      .where(eq(command.id, first.id))
    const second = await newCommand(db, serverId, 'daemon.ping')
    const results = await Promise.all([claim(db, first), claim(db, second)])
    assertEquals(results.filter((result) => result === 'claimed').length, 1)
    assertEquals(results.filter((result) => result === 'busy').length, 1)
  })
})
