import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { command, organization, server } from '../../db/schema.ts'
import { createCommandRecord, getCommandRecord, transitionCommand } from './command-records.ts'
import { claimServerTurn } from './server-turn.ts'
import type { CommandType } from './types.ts'

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

function newCommand(db: Ctx['db'], serverId: string, type: CommandType) {
  return createCommandRecord(db, {
    serverId,
    actorType: 'user',
    actorId: '00000000-0000-4000-8000-000000000001',
    type,
    payload: {},
    expiresAt: '2030-01-01T00:00:00.000Z',
  })
}

/** Claim the way the consumer does: from the row as it reads it now. */
async function claim(db: Ctx['db'], command: { id: string }) {
  const record = await getCommandRecord(db, command.id)
  if (!record) throw new TypeError(`no command ${command.id}`)
  return claimServerTurn(db, {
    commandId: record.id,
    serverId: record.serverId,
    type: record.type as CommandType,
    attempts: record.attempts,
    status: record.status,
    dispatchStartedAt: record.dispatchStartedAt,
  })
}

test('a second delivery of the same command loses the claim', async () => {
  await withServers(async ({ db, serverId }) => {
    const record = await newCommand(db, serverId, 'server.hostname.set')
    const read = {
      commandId: record.id,
      serverId,
      type: 'server.hostname.set' as CommandType,
      attempts: record.attempts,
      status: record.status,
      dispatchStartedAt: record.dispatchStartedAt,
    }
    // Both copies read the same queued row; only one may start it.
    const results = await Promise.all([claimServerTurn(db, read), claimServerTurn(db, read)])
    assertEquals(results.filter((result) => result === 'claimed').length, 1)
  })
})

test('a quick command skips the line and never holds it', async () => {
  await withServers(async ({ db, serverId }) => {
    const backup = await newCommand(db, serverId, 'server.hostname.set')
    await transitionCommand(db, backup.id, { status: 'sent' })
    // A firewall confirm must reach the server before its deadline, busy or not.
    const confirm = await newCommand(db, serverId, 'server.firewall.confirm')
    assertEquals(await claim(db, confirm), 'claimed')
    // And while it runs, it does not make the next ordinary command wait.
    await transitionCommand(db, backup.id, { status: 'succeeded' })
    const next = await newCommand(db, serverId, 'server.hostname.set')
    assertEquals(await claim(db, next), 'claimed')
  })
})

test('a command waiting its turn gets the time it waited back on its expiry', async () => {
  await withServers(async ({ db, serverId }) => {
    const running = await newCommand(db, serverId, 'server.hostname.set')
    await transitionCommand(db, running.id, { status: 'sent' })
    const waiting = await newCommand(db, serverId, 'server.hostname.set')
    // Pretend it was last seen ten minutes ago, with its expiry five minutes out.
    await db.execute(
      sql`update command set updated_at = now() - interval '10 minutes', expires_at = now() + interval '5 minutes' where id = ${waiting.id}`
    )
    assertEquals(await claim(db, waiting), 'busy')
    const [row] = await db.execute<{ minutes: number }>(
      sql`select extract(epoch from (expires_at - now())) / 60 as minutes from command where id = ${waiting.id}`
    )
    // Five minutes left plus the ten it waited, give or take the test's own runtime.
    assertEquals(Math.round(Number(row?.minutes)), 15)
  })
})

test('the first command of an idle server takes its turn and is marked dispatching', async () => {
  await withServers(async ({ db, serverId }) => {
    const record = await newCommand(db, serverId, 'server.hostname.set')
    assertEquals(await claim(db, record), 'claimed')
    const loaded = await getCommandRecord(db, record.id)
    assertEquals(loaded?.status, 'dispatching')
    assertEquals(loaded?.attempts, 1)
    assertEquals(loaded?.dispatchStartedAt !== null, true)
  })
})

test('a command waits while another command of the same server runs', async () => {
  await withServers(async ({ db, serverId, otherServerId }) => {
    const running = await newCommand(db, serverId, 'server.hostname.set')
    await transitionCommand(db, running.id, { status: 'sent' })
    const next = await newCommand(db, serverId, 'server.hostname.set')
    assertEquals(await claim(db, next), 'busy')
    assertEquals((await getCommandRecord(db, next.id))?.status, 'queued')
    // Another server is not held up.
    const elsewhere = await newCommand(db, otherServerId, 'server.hostname.set')
    assertEquals(await claim(db, elsewhere), 'claimed')
    // Once the running one ends, the next one goes.
    await transitionCommand(db, running.id, { status: 'succeeded' })
    assertEquals(await claim(db, next), 'claimed')
  })
})

test('a newer command waits for an older one of the same server that has not started', async () => {
  await withServers(async ({ db, serverId }) => {
    const older = await newCommand(db, serverId, 'server.hostname.set')
    const newer = await newCommand(db, serverId, 'server.hostname.set')
    assertEquals(await claim(db, newer), 'busy')
    assertEquals(await claim(db, older), 'claimed')
  })
})

/** Make a command look untouched for ten minutes, as one whose queue message was lost. */
async function ageCommand(db: Ctx['db'], commandId: string): Promise<void> {
  await db.execute(
    sql`update command set created_at = now() - interval '20 minutes', updated_at = now() - interval '20 minutes' where id = ${commandId}`
  )
}

test('an older queued command whose message was lost stops holding the server after the wait limit', async () => {
  await withServers(async ({ db, serverId }) => {
    const older = await newCommand(db, serverId, 'server.hostname.set')
    await ageCommand(db, older.id)
    const newer = await newCommand(db, serverId, 'server.hostname.set')
    assertEquals(await claim(db, newer), 'claimed')
  })
})

test('a command that keeps waiting its turn keeps its place however long the server is busy', async () => {
  await withServers(async ({ db, serverId }) => {
    const running = await newCommand(db, serverId, 'server.hostname.set')
    await transitionCommand(db, running.id, { status: 'sent' })
    const older = await newCommand(db, serverId, 'server.hostname.set')
    await ageCommand(db, older.id)
    // Its busy check stamps it as still waiting...
    assertEquals(await claim(db, older), 'busy')
    // ...so a newer command still waits behind it.
    const newer = await newCommand(db, serverId, 'server.hostname.set')
    assertEquals(await claim(db, newer), 'busy')
    await transitionCommand(db, running.id, { status: 'succeeded' })
    assertEquals(await claim(db, newer), 'busy')
    assertEquals(await claim(db, older), 'claimed')
  })
})

test('a deploy the server has taken over no longer holds the turn', async () => {
  await withServers(async ({ db, serverId }) => {
    const deploy = await newCommand(db, serverId, 'environment.deploy')
    await transitionCommand(db, deploy.id, { status: 'sent' })
    const next = await newCommand(db, serverId, 'server.hostname.set')
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
    const record = await newCommand(db, serverId, 'server.hostname.set')
    await transitionCommand(db, record.id, { status: 'cancelled' })
    assertEquals(await claim(db, record), 'finished')
    assertEquals((await getCommandRecord(db, record.id))?.status, 'cancelled')
  })
})

test('two consumers checking the same server at the same instant start only one command', async () => {
  await withServers(async ({ db, serverId }) => {
    // Neither waits for the other by order (the older one is past the wait
    // limit), so only the row lock keeps them apart.
    const first = await newCommand(db, serverId, 'server.hostname.set')
    await ageCommand(db, first.id)
    const second = await newCommand(db, serverId, 'server.hostname.set')
    const results = await Promise.all([claim(db, first), claim(db, second)])
    assertEquals(results.filter((result) => result === 'claimed').length, 1)
    assertEquals(results.filter((result) => result === 'busy').length, 1)
  })
})
