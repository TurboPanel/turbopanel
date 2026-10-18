/**
 * Asking hosts to remove the folders of deleted assets: what is sent, to whom,
 * and when the sweep asks again. Needs a database.
 */
import { assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { folder, principal, server } from '../../db/schema.ts'
import { applyFolderRemovalReports } from './reports.ts'
import { withFolderFixtures as withFixtures } from '../../test-fixtures/folder-world.test.support.ts'
import { getCommandDispatchPayload } from '../commands/command-records.ts'
import type { CommandEnvelope } from '../commands/envelope.ts'
import type { CommandQueue } from '../commands/queue.ts'
import {
  buildFolderRemovalPayload,
  enqueueFolderRemovals,
  FOLDERS_REMOVE_COMMAND,
  runFolderRemovalSweep,
} from './removal.ts'

const test = Deno.test.bind(Deno)

function recordingQueue(failing = false): { queue: CommandQueue; sent: CommandEnvelope[] } {
  const sent: CommandEnvelope[] = []
  return {
    sent,
    queue: {
      enqueue: (envelope) => {
        if (failing) return Promise.reject(new Error('queue down'))
        sent.push(envelope)
        return Promise.resolve()
      },
    },
  }
}

type Ctx = Parameters<Parameters<typeof withFixtures>[0]>[0]

async function addRow(
  ctx: Ctx,
  fields: { kind: 'service' | 'volume'; slug: string; state: string }
): Promise<void> {
  await ctx.db.insert(folder).values({
    serverId: ctx.serverId,
    principalId: ctx.principalId,
    // An orphan is the one state that may sit under a scope with no environment.
    environmentId: null,
    scope: 'common',
    kind: fields.kind,
    slug: fields.slug,
    state: fields.state,
  })
}

async function owner(ctx: Ctx): Promise<string> {
  const [row] = await ctx.db
    .select({ login: principal.appliedUsername })
    .from(principal)
    .where(eq(principal.id, ctx.principalId))
  return row!.login
}

test('the removal payload names a server’s removing folders, and only those', async () => {
  await withFixtures(async (ctx) => {
    assertEquals(await buildFolderRemovalPayload(ctx.db, ctx.serverId), null)
    await addRow(ctx, { kind: 'volume', slug: 'gone', state: 'removing' })
    await addRow(ctx, { kind: 'service', slug: 'old', state: 'removing' })
    await addRow(ctx, { kind: 'volume', slug: 'live', state: 'present' })
    await addRow(ctx, { kind: 'volume', slug: 'kept', state: 'orphan' })
    const login = await owner(ctx)
    const payload = await buildFolderRemovalPayload(ctx.db, ctx.serverId)
    assertEquals(
      payload?.folders
        .map(
          (entry) =>
            `${entry.kind}:${entry.folder.owner}/${entry.folder.scope}/${entry.folder.slug}`
        )
        .sort(),
      [`service:${login}/common/old`, `volume:${login}/common/gone`]
    )
  })
})

test('one command per server is queued, and a queue that is down leaves the rows and a failed command', async () => {
  await withFixtures(async (ctx) => {
    await addRow(ctx, { kind: 'volume', slug: 'gone', state: 'removing' })
    const actor = { actorType: 'system', actorId: ctx.serverId }
    const quiet = await enqueueFolderRemovals(ctx.db, undefined, actor, [ctx.serverId])
    assertEquals(quiet, { queuedServerIds: [], failedServerIds: [ctx.serverId] })

    const down = recordingQueue(true)
    const failed = await enqueueFolderRemovals(ctx.db, down.queue, actor, [ctx.serverId])
    assertEquals(failed.failedServerIds, [ctx.serverId])

    const up = recordingQueue()
    const sent = await enqueueFolderRemovals(ctx.db, up.queue, actor, [ctx.serverId, ctx.serverId])
    assertEquals(sent.queuedServerIds, [ctx.serverId])
    assertEquals(up.sent.length, 1)
    assertEquals(up.sent[0]!.type, FOLDERS_REMOVE_COMMAND)
    assertEquals((await getCommandDispatchPayload(ctx.db, up.sent[0]!.commandId)) !== null, true)
    // The row waits for the host's word, not for the command.
    const [row] = await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))
    assertEquals(row!.state, 'removing')
  })
})

test('a server with nothing removing is not asked', async () => {
  await withFixtures(async (ctx) => {
    await addRow(ctx, { kind: 'volume', slug: 'live', state: 'present' })
    const { queue, sent } = recordingQueue()
    const result = await enqueueFolderRemovals(ctx.db, queue, null, [ctx.serverId])
    assertEquals(result, { queuedServerIds: [], failedServerIds: [] })
    assertEquals(sent, [])
  })
})

test('the sweep asks a connected server once, again after it reconnects, and never an offline one', async () => {
  await withFixtures(async (ctx) => {
    await addRow(ctx, { kind: 'volume', slug: 'gone', state: 'removing' })
    const { queue, sent } = recordingQueue()
    const asked = () => sent.filter((envelope) => envelope.serverId === ctx.serverId).length

    // Offline: the rows keep waiting.
    await runFolderRemovalSweep(ctx.db, queue)
    assertEquals(asked(), 0)

    await ctx.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(server.id, ctx.serverId))
    await runFolderRemovalSweep(ctx.db, queue)
    assertEquals(asked(), 1)
    // Asked within the retry window: not again.
    await runFolderRemovalSweep(ctx.db, queue)
    assertEquals(asked(), 1)

    // The server drops and comes back: asked again straight away.
    await ctx.db
      .update(server)
      .set({ statusChangedAt: new Date(Date.now() + 1000).toISOString() })
      .where(eq(server.id, ctx.serverId))
    await runFolderRemovalSweep(ctx.db, queue)
    assertEquals(asked(), 2)

    // Nothing left removing: nobody is asked.
    await ctx.db.delete(folder).where(eq(folder.serverId, ctx.serverId))
    await ctx.db
      .update(server)
      .set({ statusChangedAt: new Date(Date.now() + 2000).toISOString() })
      .where(eq(server.id, ctx.serverId))
    await runFolderRemovalSweep(ctx.db, queue)
    assertEquals(asked(), 2)
  })
})

test('the sweep asks again after the retry window even without a reconnect', async () => {
  await withFixtures(async (ctx) => {
    await addRow(ctx, { kind: 'volume', slug: 'gone', state: 'removing' })
    await ctx.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(server.id, ctx.serverId))
    const { queue, sent } = recordingQueue()
    await runFolderRemovalSweep(ctx.db, queue)
    assertEquals(sent.length, 1)
    // Age the command past the window.
    await ctx.db.execute(
      sql`UPDATE command SET created_at = now() - interval '30 minutes' WHERE server_id = ${ctx.serverId}`
    )
    await runFolderRemovalSweep(ctx.db, queue)
    assertEquals(sent.length, 2)
  })
})

test('a removal report does not clear a row that changed after the command was built', async () => {
  await withFixtures(async (ctx) => {
    await addRow(ctx, { kind: 'volume', slug: 'gone', state: 'removing' })
    const login = await owner(ctx)
    const report = [
      { owner: login, scope: 'common', kind: 'volume' as const, slug: 'gone', removed: true },
    ]
    // Built before the row's last change: the folder may be in use again.
    const before = new Date(Date.now() - 60_000).toISOString()
    assertEquals(
      (await applyFolderRemovalReports(ctx.db, ctx.serverId, report, { updatedBefore: before }))
        .cleared,
      0
    )
    assertEquals(
      (await ctx.db.select().from(folder).where(eq(folder.serverId, ctx.serverId))).length,
      1
    )
    // Built after it: the host's word stands.
    const after = new Date(Date.now() + 60_000).toISOString()
    assertEquals(
      (await applyFolderRemovalReports(ctx.db, ctx.serverId, report, { updatedBefore: after }))
        .cleared,
      1
    )
  })
})
