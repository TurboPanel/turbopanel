/**
 * Organization CA leaves that need attention: the renewal sweep's stale and
 * back-off rules, the retire guard and deadline, and the owner routes. Needs a
 * database.
 */
import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { audit, changeover, leaf, server, tls } from '../../db/schema.ts'
import { commitPendingTlsLeafTracking } from '../../features/tls/leaf-tracking.ts'
import {
  clearLeafAttentionAfterDeploy,
  recordPendingTlsLeafFailure,
} from '../../features/tls/leaf-state.ts'
import { LEAF_STALE_NOT_NEEDED, LEAF_TEXT_MAX } from '../../features/tls/leaf-vocabulary.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { withLeafWorld, type LeafWorld } from '../../test-fixtures/tls-leaf-world.test.support.ts'
import {
  countLeafHealthForOrganization,
  loadDueTlsLeaves,
  markTlsLeafStale,
  reactivateLeavesOfReturnedServers,
  renewOneTlsLeaf,
} from './leaf-renewal-sweep.ts'
import {
  countLeavesOnOlderGeneration,
  retireAwaitingRotation,
  retireOverdueRotations,
} from './rotation-retire.ts'
import {
  loadOrganizationLeaf,
  markLeafStaleByOwner,
  reactivateLeafForRenewal,
} from './leaf-attention.ts'
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
    { nowMs }
  )
}

test('a leaf on the previous generation is due, and a stale one is counted apart', async () => {
  await withLeafWorld(async (world) => {
    const onOld = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const onNew = await world.addIngressLeaf(await world.addServer(), { generation: 2 })
    const stale = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    await world.db
      .update(leaf)
      .set({
        state: 'stale',
        staleAt: new Date().toISOString(),
        staleReason: 'x',
        staleCause: 'owner',
      })
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
    assertEquals([row.state, row.staleCause], ['stale', 'offline'])
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
    assertEquals([row.state, row.staleCause], ['stale', 'unused'])
    assertEquals(row.staleReason, LEAF_STALE_NOT_NEEDED)
  })
})

test('a later deploy brings back a leaf that was marked stale, and clears its retry count and last failure', async () => {
  await withLeafWorld(async (world) => {
    const serverId = await world.addServer()
    const id = await world.addIngressLeaf(serverId, { generation: 1 })
    await world.db
      .update(leaf)
      .set({
        state: 'stale',
        staleAt: new Date().toISOString(),
        staleReason: 'x',
        staleCause: 'unused',
        attempts: 4,
        attemptedAt: new Date().toISOString(),
        lastError: 'boom',
      })
      .where(eq(leaf.id, id))

    const metadata = {
      pendingTlsLeaf: {
        kind: 'ingress',
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
    assertEquals(
      [
        row.state,
        row.staleAt,
        row.staleReason,
        row.staleCause,
        row.attempts,
        row.attemptedAt,
        row.lastError,
      ],
      ['active', null, null, null, 0, null, null]
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
    assertEquals(await clearLeafAttentionAfterDeploy(world.db, { nothing: true }), false)
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
      .set({
        state: 'stale',
        staleAt: new Date().toISOString(),
        staleReason: 'owner said so',
        staleCause: 'owner',
      })
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
      .set({
        state: 'stale',
        staleAt: new Date().toISOString(),
        staleReason: 'Gone for weeks.',
        staleCause: 'offline',
      })
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
    assertEquals(
      [row.state, row.staleReason, row.staleCause],
      ['stale', 'Marked stale by an owner.', 'owner']
    )

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

async function retireOnce(world: LeafWorld) {
  return await retireAwaitingRotation(systemRotationContext(world.deps), world.db, {
    organizationId: world.organizationId,
    actorType: 'system',
    actorId: world.organizationId,
    enqueueGaps: false,
    deps: { commandQueue: null, ...world.deps },
  })
}

async function goneForWeeks(world: LeafWorld) {
  const serverId = await world.addServer({
    connected: false,
    statusChangedAt: new Date(Date.now() - 20 * DAY).toISOString(),
  })
  const id = await world.addIngressLeaf(serverId, { generation: 1 })
  assertEquals(await renew(world, id), 'stale')
  return { serverId, id }
}

test('a server that comes back before the retire holds the retire back until its leaf is renewed', async () => {
  await withLeafWorld(async (world) => {
    await world.addRotation('awaiting_retire')
    const { serverId, id } = await goneForWeeks(world)

    // Still offline: the stale leaf does not hold the retire back.
    assertEquals(await countLeavesOnOlderGeneration(world.db, world.organizationId, 2), 0)

    // The server reconnects: retiring now would strand it, so it waits.
    await world.db.update(server).set({ isConnected: true }).where(eq(server.id, serverId))
    assertEquals(await retireOnce(world), {
      ok: false,
      reason: 'ca_leaves_outstanding',
      outstanding: 1,
    })
    const [ca] = await world.db.select().from(tls).where(eq(tls.id, world.retiredCaId))
    assertEquals(ca!.caState, 'retired')

    // The sweep brings the leaf back; once it is renewed the retire goes through.
    assertEquals(await reactivateLeavesOfReturnedServers(world.db), 1)
    assertEquals((await leafRow(world, id)).state, 'active')
    await world.db
      .update(leaf)
      .set({ caGeneration: 2, caId: world.activeCaId })
      .where(eq(leaf.id, id))
    assertEquals((await retireOnce(world)).ok, true)
  })
})

test('a server that comes back after the retire gets its leaf back and renewed', async () => {
  await withLeafWorld(async (world) => {
    await world.addRotation('awaiting_retire')
    const { serverId, id } = await goneForWeeks(world)
    assertEquals((await retireOnce(world)).ok, true)
    const [revoked] = await world.db.select().from(tls).where(eq(tls.id, world.retiredCaId))
    assertEquals(revoked!.caState, 'revoked')

    // It returns holding a certificate from the revoked generation.
    await world.db.update(server).set({ isConnected: true }).where(eq(server.id, serverId))
    assertEquals(await reactivateLeavesOfReturnedServers(world.db), 1)
    const row = await leafRow(world, id)
    assertEquals([row.state, row.staleCause, row.staleAt, row.attempts], ['active', null, null, 0])
    // On the older generation, so it is due again and the sweep renews it.
    assertEquals((await dueIds(world)).includes(id), true)
  })
})

test('only a leaf marked stale for an offline server comes back by itself', async () => {
  await withLeafWorld(async (world) => {
    const serverId = await world.addServer()
    const byOwner = await world.addIngressLeaf(serverId, { generation: 1 })
    await markLeafStaleByOwner(world.db, world.organizationId, byOwner)
    const unusedServer = await world.addServer()
    const unused = await world.addIngressLeaf(unusedServer, { generation: 1 })
    assertEquals(await markTlsLeafStale(world.db, unused, 'no use', 'unused'), true)

    assertEquals(await reactivateLeavesOfReturnedServers(world.db), 0)
    assertEquals((await leafRow(world, byOwner)).state, 'stale')
    assertEquals((await leafRow(world, unused)).state, 'stale')
  })
})

test('a sweep that saw an old try count does not override a renewal asked for in between', async () => {
  await withLeafWorld(async (world) => {
    const serverId = await world.addServer({
      connected: false,
      statusChangedAt: new Date(Date.now() - 20 * DAY).toISOString(),
    })
    const id = await world.addIngressLeaf(serverId, { generation: 1 })
    const [seen] = (await loadDueTlsLeaves(world.db, { limit: 500, ignoreBackoff: true })).filter(
      (row) => row.id === id
    )

    // An owner asks for a renewal after the sweep read the row.
    await world.db
      .update(leaf)
      .set({ attempts: 1, attemptedAt: new Date().toISOString() })
      .where(eq(leaf.id, id))

    assertEquals(
      await markTlsLeafStale(world.db, id, 'offline', 'offline', Date.now(), seen!.attempts),
      false
    )
    assertEquals((await leafRow(world, id)).state, 'active')
    // With the current count the mark applies.
    assertEquals(await markTlsLeafStale(world.db, id, 'offline', 'offline', Date.now(), 1), true)
  })
})

test('renewing a stale leaf that turns out unused marks it stale again', async () => {
  await withLeafWorld(async (world) => {
    const id = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    await world.db
      .update(leaf)
      .set({
        state: 'stale',
        staleAt: new Date().toISOString(),
        staleReason: 'x',
        staleCause: 'owner',
        attempts: 3,
      })
      .where(eq(leaf.id, id))
    const loaded = (await loadOrganizationLeaf(world.db, world.organizationId, id))!
    const row = await reactivateLeafForRenewal(world.db, world.organizationId, id, loaded)
    assertEquals(row.attempts, 0)
    assertEquals((await leafRow(world, id)).attempts, 0)

    const outcome = await renewOneTlsLeaf(
      systemRotationContext(world.deps),
      world.db,
      queue,
      world.deps,
      { ...row, issuedAt: undefined },
      { ingress: new Set<string>(), managed: new Set<string>() },
      { skipOfflineCheck: true }
    )
    assertEquals(outcome, 'stale')
    const after = await leafRow(world, id)
    assertEquals([after.state, after.staleCause], ['stale', 'unused'])
  })
})

test('a server that never connected has its old leaf marked stale', async () => {
  await withLeafWorld(async (world) => {
    const id = await world.addIngressLeaf(await world.addServer({ connected: false }), {
      generation: 1,
    })
    await world.db
      .update(leaf)
      .set({ issuedAt: new Date(Date.now() - 20 * DAY).toISOString() })
      .where(eq(leaf.id, id))
    assertEquals(await renew(world, id), 'stale')
    assertEquals((await leafRow(world, id)).staleCause, 'offline')
  })
})

test('two renewals of the same leaf at once both finish and leave one consistent row', async () => {
  await withLeafWorld(async (world) => {
    const id = await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const [row] = (await loadDueTlsLeaves(world.db, { limit: 500, ignoreBackoff: true })).filter(
      (candidate) => candidate.id === id
    )
    const once = () =>
      renewOneTlsLeaf(
        systemRotationContext(world.deps),
        world.db,
        queue,
        world.deps,
        row!,
        { ingress: new Set<string>(), managed: new Set<string>() },
        { nowMs: Date.now() }
      )
    // Both read the row while it was active; nothing on the server uses it, so both mark it stale.
    assertEquals(await Promise.all([once(), once()]), ['stale', 'stale'])
    const after = await leafRow(world, id)
    assertEquals([after.state, after.staleCause], ['stale', 'unused'])
  })
})

test('an owner retiring the previous CA is recorded in the audit trail like the deadline retire', async () => {
  await withLeafWorld(async (world) => {
    const rotationId = await world.addRotation('awaiting_retire')
    const res = await world.request('POST', '/tls/ca/retire')
    assertEquals(res.status, 200)
    const [note] = await world.db
      .select()
      .from(audit)
      .where(and(eq(audit.organizationId, world.organizationId), eq(audit.action, 'tls.ca.retire')))
    assertEquals(note?.actorUserId, world.userId)
    assertEquals(note?.context, { rotationId, by: 'owner' })
  })
})

test('retiring over HTTP says which certificates are still on the previous CA', async () => {
  await withLeafWorld(async (world) => {
    await world.addRotation('awaiting_retire')
    await world.addIngressLeaf(await world.addServer(), { generation: 1 })
    const res = await world.request('POST', '/tls/ca/retire')
    assertEquals(res.status, 409)
    assertEquals(await res.json(), { error: 'ca_leaves_outstanding', outstandingLeaves: 1 })
  })
})
