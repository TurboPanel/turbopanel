/**
 * The destroy re-drive sweep against a real Postgres: a force-deleted
 * database whose host was offline is cleaned up once the host is back, once,
 * and never for a database that still exists. Skipped without
 * TURBOPANEL_DATABASE_URL, the way every Postgres suite is.
 */
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  command,
  environment,
  managed,
  organization,
  project,
  server,
  workspace,
} from '../../db/schema.ts'
import {
  createCommandRecord,
  getCommandDispatchPayload,
  transitionCommand,
} from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import {
  MANAGED_DESTROY_REDRIVE_FLAG,
  MANAGED_DESTROY_REDRIVE_MAX_ATTEMPTS,
  runManagedDestroyRedriveSweep,
} from './destroy-redrive.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

// A cluster that was force deleted: no managed row has this id.
const GONE_MANAGED_ID = '00000000-0000-4000-8000-0000000000b1'
const GONE_MEMBER_ID = '00000000-0000-4000-8000-0000000000b2'
const ENVIRONMENT_ID = '00000000-0000-4000-8000-0000000000b3'
const DAY_MS = 24 * 60 * 60 * 1000

type Fixture = {
  db: ReturnType<typeof createDenoDb>
  serverId: string
  sent: CommandEnvelope[]
  queue: CommandQueue
  setConnected: (connected: boolean) => Promise<void>
  /** A database row that exists, so its id is a live cluster. */
  createCluster: () => Promise<string>
  failedDestroy: (params?: {
    managedId?: string
    expiresInMs?: number
    attempts?: number
    flagged?: boolean
  }) => Promise<string>
}

async function withHost(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('destroy re-drive tests')
    return
  }
  const db = createDenoDb()
  let organizationId: string | undefined
  try {
    const [org] = await db
      .insert(organization)
      .values({ name: 'Redrive Org' })
      .returning({ id: organization.id })
    organizationId = org!.id
    const [srv] = await db
      .insert(server)
      .values({
        organizationId,
        name: 'Redrive Host',
        isConnected: false,
        statusChangedAt: new Date().toISOString(),
      })
      .returning({ id: server.id })
    const serverId = srv!.id
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Redrive Workspace', organizationId })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Redrive Project',
        workspaceId: ws!.id,
        organizationId,
        metadata: { type: 'managed', code: 'postgres' },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'production', projectId: proj!.id, serverId })
      .returning({ id: environment.id })
    const sent: CommandEnvelope[] = []
    const queue: CommandQueue = {
      enqueue: (envelope) => {
        sent.push(envelope)
        return Promise.resolve()
      },
    }
    await fn({
      db,
      serverId,
      sent,
      queue,
      createCluster: async () => {
        const [row] = await db
          .insert(managed)
          .values({
            environmentId: env!.id,
            serverId,
            name: 'Orders',
            engine: 'postgres',
            status: 'ready',
            options: { settings: {}, databases: ['postgres'] },
          })
          .returning({ id: managed.id })
        return row!.id
      },
      setConnected: async (connected) => {
        await db.update(server).set({ isConnected: connected }).where(eq(server.id, serverId))
      },
      failedDestroy: async (params = {}) => {
        const record = await createCommandRecord(db, {
          serverId,
          actorType: 'user',
          actorId: serverId,
          type: 'managed.destroy',
          payload: {
            managedId: params.managedId ?? GONE_MANAGED_ID,
            removeVolumes: true,
            memberId: GONE_MEMBER_ID,
            environmentId: ENVIRONMENT_ID,
          },
          expiresAt: new Date(Date.now() + (params.expiresInMs ?? 7 * DAY_MS)).toISOString(),
          metadata:
            params.flagged === false
              ? {}
              : {
                  [MANAGED_DESTROY_REDRIVE_FLAG]: true,
                  ...(params.attempts === undefined ? {} : { redriveAttempts: params.attempts }),
                },
        })
        await transitionCommand(db, record.id, {
          status: 'failed',
          error: 'Daemon not connected',
        })
        return record.id
      },
    })
  } finally {
    if (organizationId) {
      const servers = await db
        .select({ id: server.id })
        .from(server)
        .where(eq(server.organizationId, organizationId))
      for (const row of servers) await db.delete(command).where(eq(command.serverId, row.id))
      const projects = await db
        .select({ id: project.id })
        .from(project)
        .where(eq(project.organizationId, organizationId))
      for (const proj of projects) {
        const envs = await db
          .select({ id: environment.id })
          .from(environment)
          .where(eq(environment.projectId, proj.id))
        for (const env of envs) {
          await db.delete(managed).where(eq(managed.environmentId, env.id))
          await db.delete(environment).where(eq(environment.id, env.id))
        }
        await db.delete(project).where(eq(project.id, proj.id))
      }
      await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
      await db.delete(server).where(eq(server.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    }
    await endDbConnection(db)
  }
}

test('a destroy that failed while the host was offline is queued once when the host is back', async () => {
  await withHost(async (f) => {
    const original = await f.failedDestroy()

    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 0)
    assertEquals(f.sent.length, 0)

    await f.setConnected(true)
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 1)
    assertEquals(f.sent.length, 1)
    assertEquals(f.sent[0]?.type, 'managed.destroy')
    assertEquals(f.sent[0]?.serverId, f.serverId)
    assertEquals(f.sent[0]?.commandId === original, false)

    const payload = await getCommandDispatchPayload(f.db, f.sent[0]!.commandId)
    assertEquals(payload, {
      managedId: GONE_MANAGED_ID,
      removeVolumes: true,
      memberId: GONE_MEMBER_ID,
      environmentId: ENVIRONMENT_ID,
    })

    // The new command is open and the old one is marked as taken over.
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 0)
    assertEquals(f.sent.length, 1)
  })
})

test('a retry that fails again is tried again, but never past the attempt limit', async () => {
  await withHost(async (f) => {
    await f.setConnected(true)
    await f.failedDestroy({ attempts: MANAGED_DESTROY_REDRIVE_MAX_ATTEMPTS - 1 })
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 1)
    const retry = f.sent[0]!.commandId
    await transitionCommand(f.db, retry, { status: 'failed', error: 'Daemon not connected' })
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 0)
    assertEquals(f.sent.length, 1)
  })
})

test('an expired, unflagged or already succeeded destroy is not queued again', async () => {
  await withHost(async (f) => {
    await f.setConnected(true)
    await f.failedDestroy({ expiresInMs: -1000 })
    await f.failedDestroy({ flagged: false })
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 0)

    // A newer destroy of the same cluster on the same host already succeeded.
    await f.failedDestroy()
    const done = await createCommandRecord(f.db, {
      serverId: f.serverId,
      actorType: 'user',
      actorId: f.serverId,
      type: 'managed.destroy',
      payload: { managedId: GONE_MANAGED_ID, removeVolumes: true },
    })
    await transitionCommand(f.db, done.id, { status: 'succeeded' })
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 0)
    assertEquals(f.sent.length, 0)
  })
})

test('a database that still exists is never cleaned up, even with a failed flagged destroy', async () => {
  await withHost(async (f) => {
    await f.setConnected(true)
    const live = await f.createCluster()
    await f.failedDestroy({ managedId: live })
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 0)
    assertEquals(f.sent.length, 0)
  })
})

test('an open newer destroy of the same database on the same host blocks another one', async () => {
  await withHost(async (f) => {
    await f.setConnected(true)
    await f.failedDestroy()
    await createCommandRecord(f.db, {
      serverId: f.serverId,
      actorType: 'user',
      actorId: f.serverId,
      type: 'managed.destroy',
      payload: { managedId: GONE_MANAGED_ID, removeVolumes: true },
    })
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 0)
    assertEquals(f.sent.length, 0)
  })
})

test('a database created again with the same name has a new id and is left alone', async () => {
  await withHost(async (f) => {
    await f.setConnected(true)
    const recreated = await f.createCluster()
    await f.failedDestroy()
    assertEquals(await runManagedDestroyRedriveSweep(f.db, f.queue), 1)
    const payload = await getCommandDispatchPayload(f.db, f.sent[0]!.commandId)
    assertEquals((payload as { managedId: string }).managedId, GONE_MANAGED_ID)
    assertEquals(GONE_MANAGED_ID === recreated, false)
    const rows = await f.db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, recreated))
    assertEquals(rows.length, 1)
  })
})

test('passes running at the same time queue exactly one new destroy', async () => {
  await withHost(async (f) => {
    await f.setConnected(true)
    await f.failedDestroy()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => runManagedDestroyRedriveSweep(f.db, f.queue))
    )
    assertEquals(
      results.reduce((sum, n) => sum + n, 0),
      1
    )
    assertEquals(f.sent.length, 1)
  })
})
