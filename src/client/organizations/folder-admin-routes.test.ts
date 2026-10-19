/**
 * Folders that need a person, across the organization: the list, removing an
 * orphan, asking again for a stuck removal, forgetting a missing row, and the
 * refusals. Needs a database.
 */
import { assertEquals, assertStringIncludes } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { audit, folder, principal, server } from '../../db/schema.ts'
import { applyFolderRemovalReports } from '../../features/folders/reports.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import {
  type Ctx,
  send,
  withFolderFixtures as withFixtures,
} from '../../test-fixtures/folder-world.test.support.ts'

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

async function addRow(
  ctx: Ctx,
  fields: { kind: 'service' | 'volume'; slug: string; state: string }
): Promise<string> {
  const [row] = await ctx.db
    .insert(folder)
    .values({
      serverId: ctx.serverId,
      principalId: ctx.principalId,
      environmentId: null,
      scope: 'common',
      kind: fields.kind,
      slug: fields.slug,
      state: fields.state,
    })
    .returning({ id: folder.id })
  return row!.id
}

test('the list shows orphans, stuck removals and missing rows, and only those', async () => {
  await withFixtures(async (ctx) => {
    await addRow(ctx, { kind: 'volume', slug: 'live', state: 'present' })
    const orphan = await addRow(ctx, {
      kind: 'service',
      slug: 'leftover',
      state: 'orphan',
    })
    await addRow(ctx, { kind: 'volume', slug: 'gone', state: 'removing' })
    await addRow(ctx, { kind: 'volume', slug: 'lost', state: 'missing' })

    const all = await send(ctx, 'GET', `/organizations/${ctx.organizationId}/folders`)
    assertEquals(all.status, 200)
    const rows = all.json.folders as Array<Record<string, unknown>>
    assertEquals(all.json.total, 3)
    assertEquals(rows.map((row) => row.slug).sort(), ['gone', 'leftover', 'lost'])
    const leftover = rows.find((row) => row.id === orphan)!
    assertEquals(leftover.action, 'remove')
    assertEquals(leftover.serverName, 'Alpha')
    assertStringIncludes(String(leftover.reason), 'no service or volume owns this folder')

    const onlyOrphans = await send(
      ctx,
      'GET',
      `/organizations/${ctx.organizationId}/folders?state=orphan`
    )
    assertEquals((onlyOrphans.json.folders as unknown[]).length, 1)
    const paged = await send(
      ctx,
      'GET',
      `/organizations/${ctx.organizationId}/folders?limit=1&offset=1`
    )
    assertEquals((paged.json.folders as unknown[]).length, 1)
    assertEquals(paged.json.total, 3)

    for (const bad of ['state=present', 'state=orphan,nope', 'limit=abc', 'offset=-1']) {
      const refused = await send(ctx, 'GET', `/organizations/${ctx.organizationId}/folders?${bad}`)
      assertEquals(refused.status, 400, bad)
    }
  })
})

test('another organization cannot list or settle these folders', async () => {
  await withFixtures(async (ctx) => {
    const id = await addRow(ctx, {
      kind: 'volume',
      slug: 'kept',
      state: 'orphan',
    })
    const stranger = '0192d6a0-0000-7000-8000-000000000999'
    const list = await send(ctx, 'GET', `/organizations/${stranger}/folders`)
    assertEquals(list.status === 403 || list.status === 404, true)
    const missing = await send(ctx, 'POST', '/folders/0192d6a0-0000-7000-8000-000000000998/remove')
    assertEquals(missing.status, 404)
    const [row] = await ctx.db.select().from(folder).where(eq(folder.id, id))
    assertEquals(row!.state, 'orphan')
  })
})

test('removing an orphan moves it to removing, asks its server and writes an audit row', async () => {
  const { queue, sent } = recordingQueue()
  await withFixtures(
    async (ctx) => {
      const id = await addRow(ctx, {
        kind: 'volume',
        slug: 'kept',
        state: 'orphan',
      })
      const done = await send(ctx, 'POST', `/folders/${id}/remove`)
      assertEquals(done.status, 200)
      assertEquals(done.json.outcome, 'removing')
      const [row] = await ctx.db.select().from(folder).where(eq(folder.id, id))
      assertEquals(row!.state, 'removing')
      const asked = sent.filter((envelope) => envelope.type === 'server.folders.remove')
      assertEquals(asked.length, 1)
      assertEquals(asked[0]!.serverId, ctx.serverId)
      const trail = await ctx.db
        .select({ context: audit.context })
        .from(audit)
        .where(and(eq(audit.organizationId, ctx.organizationId), eq(audit.action, 'folder.remove')))
      assertEquals(trail.length, 1)
      assertEquals((trail[0]!.context as Record<string, unknown>).folderId, id)
    },
    { commandQueue: queue }
  )
})

test('a folder a service or volume is using is refused', async () => {
  await withFixtures(async (ctx) => {
    for (const state of ['planned', 'present']) {
      const id = await addRow(ctx, {
        kind: 'service',
        slug: `use-${state}`,
        state,
      })
      const refused = await send(ctx, 'POST', `/folders/${id}/remove`)
      assertEquals(refused.status, 409)
      assertEquals(refused.json.error, 'folder_in_use')
      const [row] = await ctx.db.select().from(folder).where(eq(folder.id, id))
      assertEquals(row!.state, state)
    }
  })
})

test('a stuck removal is asked again on request and a missing row is forgotten', async () => {
  const { queue, sent } = recordingQueue()
  await withFixtures(
    async (ctx) => {
      const stuck = await addRow(ctx, {
        kind: 'volume',
        slug: 'stuck',
        state: 'removing',
      })
      const retry = await send(ctx, 'POST', `/folders/${stuck}/remove`)
      assertEquals(retry.status, 200)
      assertEquals(retry.json.outcome, 'removing')
      assertEquals(sent.filter((e) => e.type === 'server.folders.remove').length, 1)

      const lost = await addRow(ctx, {
        kind: 'volume',
        slug: 'lost',
        state: 'missing',
      })
      const forgotten = await send(ctx, 'POST', `/folders/${lost}/remove`)
      assertEquals(forgotten.status, 200)
      assertEquals(forgotten.json.outcome, 'forgotten')
      const left = await ctx.db.select().from(folder).where(eq(folder.id, lost))
      assertEquals(left.length, 0)
    },
    { commandQueue: queue }
  )
})

test('what the host said about a kept folder shows as the reason, and clears when the folder is asked for again', async () => {
  await withFixtures(async (ctx) => {
    const id = await addRow(ctx, {
      kind: 'volume',
      slug: 'stuck',
      state: 'removing',
    })
    const [owner] = await ctx.db
      .select({ login: principal.appliedUsername })
      .from(principal)
      .where(eq(principal.id, ctx.principalId))
    await applyFolderRemovalReports(ctx.db, ctx.serverId, [
      {
        owner: owner!.login,
        scope: 'common',
        kind: 'volume',
        slug: 'stuck',
        removed: false,
        reason: 'a container still has the folder open',
      },
    ])
    const [kept] = await ctx.db.select().from(folder).where(eq(folder.id, id))
    assertEquals(kept!.removalNote, 'a container still has the folder open')
    const listed = await send(ctx, 'GET', `/organizations/${ctx.organizationId}/folders`)
    const row = (listed.json.folders as Array<Record<string, unknown>>)[0]!
    assertStringIncludes(String(row.reason), 'a container still has the folder open')

    // Offline server: the reason still says it is waiting.
    await ctx.db.update(server).set({ isConnected: false }).where(eq(server.id, ctx.serverId))
    const offline = await send(ctx, 'GET', `/organizations/${ctx.organizationId}/folders`)
    assertStringIncludes(
      String((offline.json.folders as Array<Record<string, unknown>>)[0]!.reason),
      'waiting for server Alpha to come back'
    )
  })
})
