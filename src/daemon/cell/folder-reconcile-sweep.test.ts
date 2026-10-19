/**
 * The periodic folder listing: a connected server with folder rows is asked
 * for a fresh reconcile when its last one is old, and not before. Needs a
 * database.
 */
import { assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { folder, principalPlacement, server } from '../../db/schema.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { withFolderFixtures as withFixtures } from '../../test-fixtures/folder-world.test.support.ts'
import { runFolderReconcileSweep } from './folder-reconcile-sweep.ts'

const test = Deno.test.bind(Deno)

function recordingQueue(): { queue: CommandQueue; sent: CommandEnvelope[] } {
  const sent: CommandEnvelope[] = []
  return {
    sent,
    queue: {
      enqueue: (envelope) => {
        sent.push(envelope)
        return Promise.resolve()
      },
    },
  }
}

test('a connected server with folders is asked once, again after the interval, and an idle or offline one never', async () => {
  await withFixtures(async (ctx) => {
    const { queue, sent } = recordingQueue()
    const asked = () => sent.filter((e) => e.type === 'server.principals.reconcile').length

    await ctx.db.insert(folder).values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: null,
      scope: 'common',
      kind: 'volume',
      slug: 'data',
      state: 'present',
    })
    await ctx.db.insert(principalPlacement).values({
      principalId: ctx.principalId,
      serverId: ctx.serverId,
      state: 'present',
      home: `/srv/users/${ctx.principalId}`,
      source: 'manual',
    })

    // Offline: nobody is asked.
    await runFolderReconcileSweep(ctx.db, queue)
    assertEquals(asked(), 0)

    await ctx.db
      .update(server)
      .set({ isConnected: true, statusChangedAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(server.id, ctx.serverId))
    await runFolderReconcileSweep(ctx.db, queue)
    assertEquals(asked(), 1)
    // Asked within the interval: not again.
    await runFolderReconcileSweep(ctx.db, queue)
    assertEquals(asked(), 1)

    // Past the interval: asked again.
    await ctx.db.execute(
      sql`UPDATE command SET created_at = now() - interval '7 hours' WHERE server_id = ${ctx.serverId}`
    )
    await runFolderReconcileSweep(ctx.db, queue)
    assertEquals(asked(), 2)

    // A server with no folder rows has nothing to compare.
    await ctx.db.delete(folder).where(eq(folder.serverId, ctx.serverId))
    await ctx.db.execute(
      sql`UPDATE command SET created_at = now() - interval '14 hours' WHERE server_id = ${ctx.serverId}`
    )
    await runFolderReconcileSweep(ctx.db, queue)
    assertEquals(asked(), 2)
  })
})
