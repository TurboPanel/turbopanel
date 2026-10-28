/**
 * Peer leaves in the database: the widened kind check, one peer leaf per
 * server, the deploy commit, and how the renewal sweep and the retire guard
 * treat them after an Organization CA changeover. Needs a database.
 */
import { assertEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { leaf } from '../../db/schema.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { clearLeafAttentionAfterDeploy } from '../../features/tls/leaf-state.ts'
import { commitPendingTlsLeafTracking } from '../../features/tls/leaf-tracking.ts'
import { withLeafWorld, type LeafWorld } from '../../test-fixtures/tls-leaf-world.test.support.ts'
import { loadDueTlsLeaves, renewOneTlsLeaf } from './leaf-renewal-sweep.ts'
import { countLeavesOnOlderGeneration } from './rotation-retire.ts'
import { systemRotationContext } from './system-context.ts'

const test = Deno.test.bind(Deno)

const DAY = 86_400_000
const queue: CommandQueue = { enqueue: () => Promise.resolve() }

async function leafRow(world: LeafWorld, id: string) {
  const [row] = await world.db.select().from(leaf).where(eq(leaf.id, id))
  return row!
}

test('the kind check accepts a peer leaf, one per server, and refuses an unknown kind', async () => {
  await withLeafWorld(async (world) => {
    const serverId = await world.addServer()
    await world.addPeerLeaf(serverId)
    await assertRejects(() => world.addPeerLeaf(serverId))
    // The same server still has its own ingress leaf next to the peer leaf.
    await world.addIngressLeaf(serverId)
    await assertRejects(() =>
      world.db.insert(leaf).values({
        organizationId: world.organizationId,
        serverId,
        kind: 'bogus',
        caId: world.activeCaId,
        caGeneration: 2,
        notAfter: new Date(Date.now() + DAY).toISOString(),
      })
    )
  })
})

test('a delivered peer leaf replaces the tracked one in place and clears its attention marks', async () => {
  await withLeafWorld(async (world) => {
    const serverId = await world.addServer()
    const id = await world.addPeerLeaf(serverId, { generation: 1 })
    await world.db.update(leaf).set({ attempts: 2, lastError: 'x' }).where(eq(leaf.id, id))
    const metadata = {
      pendingTlsLeaf: {
        kind: 'peer',
        organizationId: world.organizationId,
        serverId,
        caId: world.activeCaId,
        caGeneration: 2,
        notAfter: new Date(Date.now() + 90 * DAY).toISOString(),
      },
    }
    assertEquals(await commitPendingTlsLeafTracking(world.db, metadata), true)
    assertEquals(await clearLeafAttentionAfterDeploy(world.db, metadata), true)
    const row = await leafRow(world, id)
    assertEquals([row.caGeneration, row.attempts, row.lastError], [2, 0, null])
    const rows = await world.db.select().from(leaf).where(eq(leaf.serverId, serverId))
    assertEquals(rows.length, 1)
  })
})

test('after a changeover a peer leaf on the previous generation is due and holds back the retire', async () => {
  await withLeafWorld(async (world) => {
    const onOld = await world.addPeerLeaf(await world.addServer(), { generation: 1 })
    const onNew = await world.addPeerLeaf(await world.addServer(), { generation: 2 })
    const ids = (await loadDueTlsLeaves(world.db, { limit: 500 }))
      .filter((row) => row.organizationId === world.organizationId)
      .map((row) => row.id)
    assertEquals(ids.includes(onOld), true)
    assertEquals(ids.includes(onNew), false)
    assertEquals(await countLeavesOnOlderGeneration(world.db, world.organizationId, 2), 1)
  })
})

test('the sweep leaves a due peer leaf alone without a delivery and remembers a failed issue', async () => {
  await withLeafWorld(async (world) => {
    const id = await world.addPeerLeaf(await world.addServer(), { generation: 1 })
    const [row] = (await loadDueTlsLeaves(world.db, { limit: 500, ignoreBackoff: true })).filter(
      (candidate) => candidate.id === id
    )
    const seen = { ingress: new Set<string>(), managed: new Set<string>() }
    const context = systemRotationContext(world.deps)

    assertEquals(await renewOneTlsLeaf(context, world.db, queue, world.deps, row!, seen), 'skipped')
    assertEquals((await leafRow(world, id)).attempts, 0)

    // The test server has no daemon key, so issuing fails and the try is recorded.
    const deps = { ...world.deps, deliverPeerLeaf: () => Promise.resolve({ ok: true as const }) }
    assertEquals(await renewOneTlsLeaf(context, world.db, queue, deps, row!, seen), 'failed')
    const after = await leafRow(world, id)
    assertEquals(after.attempts, 1)
    assertEquals(after.lastError?.startsWith('The peer certificate could not be issued'), true)
  })
})
