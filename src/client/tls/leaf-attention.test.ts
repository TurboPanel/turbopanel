/**
 * Organization CA leaves that need attention: the renewal sweep's stale and
 * back-off rules, the retire guard and deadline, and the owner routes. Needs a
 * database.
 */
import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { audit, changeover, leaf, tls } from '../../db/schema.ts'
import {
  recordPendingTlsLeafFailure,
  upsertTlsLeafTracking,
} from '../../features/tls/leaf-tracking.ts'
import { LEAF_STALE_NOT_NEEDED, LEAF_TEXT_MAX } from '../../features/tls/leaf-vocabulary.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { withLeafWorld, type LeafWorld } from '../../test-fixtures/tls-leaf-world.test.support.ts'
import {
  countLeafHealthForOrganization,
  loadDueTlsLeaves,
  renewOneTlsLeaf,
} from './leaf-renewal-sweep.ts'
import { retireAwaitingRotation, retireOverdueRotations } from './rotation-retire.ts'
import { systemRotationContext } from './system-context.ts'

const test = Deno.test.bind(Deno)

const DAY = 86_400_000
const HOUR = 3_600_000

const queue: CommandQueue = { enqueue: () => Promise.resolve() }

async function leafRow(world: LeafWorld, id: string) {
  const [row] = await world.db.select().from(leaf).where(eq(leaf.id, id))
  return row!
}

async function dueIds(world: LeafWorld, params: { nowMs?: number; ignoreBackoff?: boolean } = {}) {
  const rows = await loadDueTlsLeaves(world.db, { ...params, limit: 500 })
  return rows.filter((row) => row.organizationId === world.organizationId).map((row) => row.id)
}

async function renew(world: LeafWorld, id: string, nowMs?: number) {
  const [row] = (await loadDueTlsLeaves(world.db, { limit: 500, ignoreBackoff: true })).filter(
    (candidate) => candidate.id === id
  )
  return await renewOneTlsLeaf(
    systemRotationContext(world.deps),
    world.db,
    queue,
    world.deps,
    row!,
    { ingress: new Set<string>(), managed: new Set<string>() },
    nowMs
  )
}

test('a leaf on the previous generation is due, and a stale one is counted apart', async () => {
  await withLeafWorld(async (world) => {
    const onOld = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const onNew = await world.addIngressLeaf(await world.addServer(), { generation: 2 })
    const stale = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    await world.db
      .update(leaf)
      .set({ state: 'stale', staleAt: new Date().toISOString(), staleReason: 'x' })
      .where(eq(leaf.id, stale))

    const health = await countLeafHealthForOrganization(world.db, world.organizationId, {
      activeCaGeneration: 2,
    })
    assertEquals(health, { dueCount: 1, staleCount: 1 })
    const ids = await dueIds(world)
    assertEquals(ids.includes(onOld), true)
    assertEquals(ids.includes(onNew), false)
    assertEquals(ids.includes(stale), false)
  })
})

test('a leaf tried recently waits out its back-off, a stale one is never offered', async () => {
  await withLeafWorld(async (world) => {
    const tried = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const untried = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const now = Date.now()
    await world.db
      .update(leaf)
      .set({ attempts: 1, attemptedAt: new Date(now - 10 * 60_000).toISOString() })
      .where(eq(leaf.id, tried))

    let ids = await dueIds(world, { nowMs: now })
    assertEquals(ids.includes(untried), true)
    assertEquals(ids.includes(tried), false)

    ids = await dueIds(world, { nowMs: now, ignoreBackoff: true })
    assertEquals(ids.includes(tried), true)

    // 30 minutes * 2^1 = one hour after the try, the leaf is ready again.
    ids = await dueIds(world, { nowMs: now + 2 * HOUR })
    assertEquals(ids.includes(tried), true)
  })
})

test('the wait never grows past a day', async () => {
  await withLeafWorld(async (world) => {
    const stuck = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const now = Date.now()
    await world.db
      .update(leaf)
      .set({ attempts: 500, attemptedAt: new Date(now).toISOString() })
      .where(eq(leaf.id, stuck))
    assertEquals((await dueIds(world, { nowMs: now + 23 * HOUR })).includes(stuck), false)
    assertEquals((await dueIds(world, { nowMs: now + 25 * HOUR })).includes(stuck), true)
  })
})

test('a server offline for weeks has its leaf marked stale with the day it went offline', async () => {
  await withLeafWorld(async (world) => {
    const wentOff = new Date(Date.now() - 20 * DAY).toISOString()
    const serverId = await world.addServer({ connected: false, statusChangedAt: wentOff })
    const id = await world.addIngressLeaf(serverId, { generation: 1 })

    assertEquals(await renew(world, id), 'stale')
    const row = await leafRow(world, id)
    assertEquals(row.state, 'stale')
    assertEquals(row.staleReason, `The server has been offline since ${wentOff.slice(0, 10)}.`)
    assertEquals(row.staleAt !== null, true)
    assertEquals(
      await countLeafHealthForOrganization(world.db, world.organizationId, {
        activeCaGeneration: 2,
      }),
      { dueCount: 0, staleCount: 1 }
    )
  })
})

test('an ingress leaf nothing on the server uses is marked stale instead of renewed forever', async () => {
  await withLeafWorld(async (world) => {
    const id = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    assertEquals(await renew(world, id), 'stale')
    const row = await leafRow(world, id)
    assertEquals(row.state, 'stale')
    assertEquals(row.staleReason, LEAF_STALE_NOT_NEEDED)
  })
})

test('a deploy clears the stale mark, the retry count and the last failure', async () => {
  await withLeafWorld(async (world) => {
    const serverId = await world.addServer()
    const id = await world.addIngressLeaf(serverId, { generation: 1 })
    await world.db
      .update(leaf)
      .set({
        state: 'stale',
        staleAt: new Date().toISOString(),
        staleReason: 'x',
        attempts: 4,
        attemptedAt: new Date().toISOString(),
        lastError: 'boom',
      })
      .where(eq(leaf.id, id))

    await upsertTlsLeafTracking(world.db, {
      kind: 'ingress',
      organizationId: world.organizationId,
      serverId,
      caId: world.activeCaId,
      caGeneration: 2,
      notAfter: new Date(Date.now() + 90 * DAY).toISOString(),
    })
    const row = await leafRow(world, id)
    assertEquals(
      [row.state, row.staleAt, row.staleReason, row.attempts, row.attemptedAt, row.lastError],
      ['active', null, null, 0, null, null]
    )
    assertEquals(row.caGeneration, 2)
  })
})

test('a failed command keeps its reason on the deployed leaf, cut to 300 characters', async () => {
  await withLeafWorld(async (world) => {
    const serverId = await world.addServer()
    const id = await world.addIngressLeaf(serverId, { generation: 1 })
    const metadata = {
      pendingTlsLeaf: {
        kind: 'ingress',
        organizationId: world.organizationId,
        serverId,
        caId: world.activeCaId,
        caGeneration: 2,
        notAfter: new Date().toISOString(),
      },
    }
    assertEquals(
      await recordPendingTlsLeafFailure(world.db, metadata, 'ProxySQL would not reload'),
      true
    )
    assertEquals((await leafRow(world, id)).lastError, 'ProxySQL would not reload')

    await recordPendingTlsLeafFailure(world.db, metadata, 'y'.repeat(2000))
    assertEquals((await leafRow(world, id)).lastError!.length, LEAF_TEXT_MAX)

    assertEquals(await recordPendingTlsLeafFailure(world.db, { nothing: true }, 'ignored'), false)
  })
})

test('the previous generation is not retired while an active leaf still needs it', async () => {
  await withLeafWorld(async (world) => {
    await world.addRotation('awaiting_retire')
    const id = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const run = () =>
      retireAwaitingRotation(systemRotationContext(world.deps), world.db, {
        organizationId: world.organizationId,
        actorType: 'system',
        actorId: world.organizationId,
        enqueueGaps: false,
        deps: { commandQueue: null, ...world.deps },
      })

    assertEquals(await run(), { ok: false, reason: 'ca_leaves_outstanding', outstanding: 1 })
    const [ca] = await world.db.select().from(tls).where(eq(tls.id, world.retiredCaId))
    assertEquals(ca!.caState, 'retired')

    await world.db
      .update(leaf)
      .set({ state: 'stale', staleAt: new Date().toISOString(), staleReason: 'owner said so' })
      .where(eq(leaf.id, id))
    const done = await run()
    assertEquals(done.ok, true)
    const [revoked] = await world.db.select().from(tls).where(eq(tls.id, world.retiredCaId))
    assertEquals(revoked!.caState, 'revoked')
    const [journal] = await world.db
      .select()
      .from(changeover)
      .where(eq(changeover.organizationId, world.organizationId))
    assertEquals(journal!.state, 'completed')
  })
})

test('the sweep retires a rotation only after its deadline has passed', async () => {
  await withLeafWorld(async (world) => {
    const now = Date.now()
    const rotationId = await world.addRotation('awaiting_retire', {
      retireBy: new Date(now + 5 * DAY).toISOString(),
    })
    const deps = { commandQueue: null, ...world.deps }

    const early = await retireOverdueRotations(world.db, deps, now)
    assertEquals(early.retired, 0)

    await world.db
      .update(changeover)
      .set({ retireBy: new Date(now - HOUR).toISOString() })
      .where(eq(changeover.id, rotationId))
    const late = await retireOverdueRotations(world.db, deps, now)
    assertEquals(late.retired >= 1, true)

    const [journal] = await world.db.select().from(changeover).where(eq(changeover.id, rotationId))
    assertEquals(journal!.state, 'completed')
    const [note] = await world.db
      .select()
      .from(audit)
      .where(and(eq(audit.organizationId, world.organizationId), eq(audit.action, 'tls.ca.retire')))
    assertEquals(note?.targetId, world.organizationId)
  })
})

test('an overdue rotation that still has an active leaf on the old generation stays pending', async () => {
  await withLeafWorld(async (world) => {
    const now = Date.now()
    const rotationId = await world.addRotation('awaiting_retire', {
      retireBy: new Date(now - HOUR).toISOString(),
    })
    await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    await retireOverdueRotations(world.db, { commandQueue: null, ...world.deps }, now)
    const [journal] = await world.db.select().from(changeover).where(eq(changeover.id, rotationId))
    assertEquals(journal!.state, 'awaiting_retire')
  })
})

test('GET /tls/ca/leaves lists due and stale leaves with their server and reason', async () => {
  await withLeafWorld(async (world) => {
    const due = await world.addIngressLeaf(await world.addServer({ name: 'Frankfurt 1' }), {
      generation: 1,
    })
    const stale = await world.addIngressLeaf(await world.addServer({ name: 'Old box' }), {
      generation: 1,
    })
    await world.addIngressLeaf(await world.addServer({ name: 'Healthy' }), { generation: 2 })
    await world.db
      .update(leaf)
      .set({ state: 'stale', staleAt: new Date().toISOString(), staleReason: 'Gone for weeks.' })
      .where(eq(leaf.id, stale))

    const res = await world.request('GET', '/tls/ca/leaves')
    assertEquals(res.status, 200)
    const body = (await res.json()) as {
      leaves: {
        id: string
        state: string
        serverName: string
        reason: string
        staleReason: string | null
      }[]
      dueCount: number
      staleCount: number
      caGeneration: number
      truncated: boolean
    }
    assertEquals(
      [body.dueCount, body.staleCount, body.caGeneration, body.truncated],
      [1, 1, 2, false]
    )
    assertEquals(
      body.leaves.map((row) => [row.id, row.state, row.serverName]),
      [
        [due, 'due', 'Frankfurt 1'],
        [stale, 'stale', 'Old box'],
      ]
    )
    assertEquals(body.leaves[0]!.reason, 'Still signed by a previous Organization CA generation.')
    assertEquals(body.leaves[1]!.staleReason, 'Gone for weeks.')
  })
})

test('an owner can mark a leaf stale and delete its record, and each is recorded', async () => {
  await withLeafWorld(async (world) => {
    const id = await world.addIngressLeaf(await world.addServer(), { generation: 1 })

    const marked = await world.request('POST', `/tls/ca/leaves/${id}/stale`)
    assertEquals(marked.status, 200)
    const row = await leafRow(world, id)
    assertEquals([row.state, row.staleReason], ['stale', 'Marked stale by an owner.'])

    const removed = await world.request('DELETE', `/tls/ca/leaves/${id}`)
    assertEquals(removed.status, 200)
    assertEquals((await world.db.select().from(leaf).where(eq(leaf.id, id))).length, 0)

    const again = await world.request('DELETE', `/tls/ca/leaves/${id}`)
    assertEquals(again.status, 404)

    const actions = (
      await world.db.select().from(audit).where(eq(audit.organizationId, world.organizationId))
    ).map((entry) => entry.action)
    assertEquals(actions.sort(), ['tls.leaf.delete', 'tls.leaf.stale'])
  })
})

test('a leaf of another organization is not found, whatever its id', async () => {
  await withLeafWorld(async (mine) => {
    await withLeafWorld(async (theirs) => {
      const id = await theirs.addIngressLeaf(await theirs.addServer(), { generation: 1 })
      for (const [method, path] of [
        ['POST', `/tls/ca/leaves/${id}/stale`],
        ['POST', `/tls/ca/leaves/${id}/renew`],
        ['DELETE', `/tls/ca/leaves/${id}`],
      ] as const) {
        assertEquals((await mine.request(method, path)).status, 404, `${method} ${path}`)
      }
      assertEquals((await leafRow(theirs, id)).state, 'active')
      assertEquals((await mine.request('DELETE', '/tls/ca/leaves/not-a-uuid')).status, 404)
    })
  })
})

test('renewing a leaf says so plainly when no command queue is available', async () => {
  await withLeafWorld(async (world) => {
    const id = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const res = await world.request('POST', `/tls/ca/leaves/${id}/renew`)
    assertEquals(res.status, 503)
    assertEquals((await leafRow(world, id)).state, 'active')
  })
})
