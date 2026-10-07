import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { organization, server, topologyGeneration } from '../../db/schema.ts'
import {
  getLatestTopologyGeneration,
  getLatestTopologyGenerations,
  getTopologyGeneration,
  layoutPathsFromSnapshot,
  MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR,
  MAX_RETAINED_TOPOLOGY_GENERATIONS,
  recordTopologyGeneration,
  resetTopologyChurnLogForTests,
} from './server-topology-records.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withServerFixture(
  fn: (ctx: { db: ReturnType<typeof createDenoDb>; serverId: string }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('server topology records tests')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Topology Records Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Server Topology Records Server',
      isConnected: true,
      statusChangedAt: now,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, serverId })
  } finally {
    await db.delete(topologyGeneration).where(eq(topologyGeneration.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('layoutPathsFromSnapshot reads a v6 snapshot and answers null for older or malformed ones', () => {
  assertEquals(
    layoutPathsFromSnapshot({
      generation: 3,
      paths: { backup: '/mnt/nas/backups', logs: '/var/log/turbopanel' },
    }),
    { backup: '/mnt/nas/backups', logs: '/var/log/turbopanel' }
  )
  // Pre-v6 daemon: no `paths` at all.
  assertEquals(layoutPathsFromSnapshot({ generation: 3, hardwareSignals: [] }), null)
  // Half a record is no record.
  assertEquals(layoutPathsFromSnapshot({ paths: { backup: '/backup' } }), null)
  assertEquals(
    layoutPathsFromSnapshot({ paths: { backup: '', logs: '/var/log/turbopanel' } }),
    null
  )
  assertEquals(layoutPathsFromSnapshot(null), null)
  assertEquals(layoutPathsFromSnapshot([]), null)
})

test('getLatestTopologyGeneration returns the highest recorded generation', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyGeneration(db, serverId, {
      generation: 2,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a', 'nic-b'] },
      appliedAt: '2026-01-01T00:05:00.000Z',
    })

    const latest = await getLatestTopologyGeneration(db, serverId)
    assertEquals(latest?.generation, 2)
    assertEquals(latest?.bootGeneration, 1)
    // The daemon-reported object is stored directly — never wrapped.
    assertEquals(latest?.snapshot, { devices: ['nic-a', 'nic-b'] })
    // The daemon's own report timestamp is preserved, not a receipt time.
    assertEquals(Date.parse(latest?.appliedAt ?? ''), Date.parse('2026-01-01T00:05:00.000Z'))
  })
})

async function withTwoServerFixture(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverIdA: string
    serverIdB: string
    serverIdC: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('server topology records tests')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Topology Records Batch Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const insertedServers = await db
    .insert(server)
    .values(
      ['A', 'B', 'C'].map((label) => ({
        organizationId,
        name: `Server Topology Records Batch Server ${label}`,
        isConnected: true,
        statusChangedAt: now,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      }))
    )
    .returning({ id: server.id })
  const [serverIdA, serverIdB, serverIdC] = insertedServers.map((row) => row.id)

  try {
    await fn({
      db,
      serverIdA: serverIdA!,
      serverIdB: serverIdB!,
      serverIdC: serverIdC!,
    })
  } finally {
    for (const serverId of [serverIdA, serverIdB, serverIdC]) {
      await db.delete(topologyGeneration).where(eq(topologyGeneration.serverId, serverId!))
      await db.delete(server).where(eq(server.id, serverId!))
    }
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('getLatestTopologyGenerations returns the highest generation per server in one query, omitting servers with none recorded', async () => {
  await withTwoServerFixture(async ({ db, serverIdA, serverIdB, serverIdC }) => {
    await recordTopologyGeneration(db, serverIdA, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['a-gen1'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyGeneration(db, serverIdA, {
      generation: 2,
      bootGeneration: 1,
      snapshot: { devices: ['a-gen2'] },
      appliedAt: '2026-01-01T00:05:00.000Z',
    })
    await recordTopologyGeneration(db, serverIdB, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['b-gen1'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    // serverIdC deliberately has no recorded generation.

    const byServer = await getLatestTopologyGenerations(db, [serverIdA, serverIdB, serverIdC])
    assertEquals(byServer.size, 2)
    assertEquals(byServer.get(serverIdA)?.generation, 2)
    assertEquals(byServer.get(serverIdA)?.snapshot, { devices: ['a-gen2'] })
    assertEquals(byServer.get(serverIdB)?.generation, 1)
    assertEquals(byServer.has(serverIdC), false)
  })
})

test('getLatestTopologyGenerations returns an empty map for an empty serverIds list without querying', async () => {
  await withTwoServerFixture(async ({ db }) => {
    const byServer = await getLatestTopologyGenerations(db, [])
    assertEquals(byServer.size, 0)
  })
})

test('getTopologyGeneration resolves a specific historical generation', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyGeneration(db, serverId, {
      generation: 2,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a', 'nic-b'] },
      appliedAt: '2026-01-01T00:05:00.000Z',
    })

    const historical = await getTopologyGeneration(db, serverId, 1)
    assertEquals(historical?.generation, 1)
    assertEquals(historical?.snapshot, { devices: ['nic-a'] })
    assertEquals(Date.parse(historical?.appliedAt ?? ''), Date.parse('2026-01-01T00:00:00.000Z'))

    const missing = await getTopologyGeneration(db, serverId, 99)
    assertEquals(missing, undefined)
  })
})

test('recordTopologyGeneration is idempotent for a repeated generation number', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a'] },
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    // Simulates the daemon resending an unchanged generation on reconnect.
    await recordTopologyGeneration(db, serverId, {
      generation: 1,
      bootGeneration: 1,
      snapshot: { devices: ['nic-a', 'nic-b-should-not-be-recorded'] },
      appliedAt: '2026-01-01T00:10:00.000Z',
    })

    const rows = await db
      .select()
      .from(topologyGeneration)
      .where(eq(topologyGeneration.serverId, serverId))
    assertEquals(rows.length, 1)

    const record = await getTopologyGeneration(db, serverId, 1)
    assertEquals(record?.snapshot, { devices: ['nic-a'] })
    // The second call's appliedAt is dropped along with the rest of its row.
    assertEquals(Date.parse(record?.appliedAt ?? ''), Date.parse('2026-01-01T00:00:00.000Z'))
  })
})

const REPORT_AT = '2026-01-01T00:00:00.000Z'

async function topologyRowCount(
  db: ReturnType<typeof createDenoDb>,
  serverId: string
): Promise<number> {
  const rows = await db
    .select({ id: topologyGeneration.id })
    .from(topologyGeneration)
    .where(eq(topologyGeneration.serverId, serverId))
  return rows.length
}

test('a flood of fake generation numbers cannot grow the table past the hourly limit', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const outcomes: string[] = []
    for (let i = 0; i < 200; i++) {
      outcomes.push(
        await recordTopologyGeneration(db, serverId, {
          // Distinct, scattered numbers and a fat snapshot each: the worst a daemon can send.
          generation: 1000 + i * 7919,
          bootGeneration: i,
          snapshot: { pad: 'x'.repeat(2000), i },
          appliedAt: REPORT_AT,
        })
      )
    }
    assertEquals(await topologyRowCount(db, serverId), MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR)
    assertEquals(
      outcomes.filter((outcome) => outcome === 'recorded').length,
      MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR
    )
    assertEquals(
      outcomes.filter((outcome) => outcome === 'rate_limited').length,
      200 - MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR
    )
    const [row] = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
    const metadata = row!.metadata as Record<string, unknown>
    assert(
      typeof metadata.topologyChurnLimitedAt === 'string',
      'the limit hit is stamped as a durable alert'
    )
  })
})

test('generation numbers the table cannot hold are rejected and write nothing', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    for (const generation of [2_147_483_648, 1e300, -1, 1.5, Number.NaN]) {
      assertEquals(
        await recordTopologyGeneration(db, serverId, {
          generation,
          bootGeneration: 0,
          snapshot: {},
          appliedAt: REPORT_AT,
        }),
        'rejected'
      )
    }
    assertEquals(
      await recordTopologyGeneration(db, serverId, {
        generation: 1,
        bootGeneration: 2_147_483_648,
        snapshot: {},
        appliedAt: REPORT_AT,
      }),
      'rejected'
    )
    assertEquals(await topologyRowCount(db, serverId), 0)
  })
})

test('resending a generation refreshes its snapshot in place and never adds a row', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    const first = { generation: 4, bootGeneration: 1, appliedAt: REPORT_AT }
    assertEquals(
      await recordTopologyGeneration(db, serverId, { ...first, snapshot: { memory: 1 } }),
      'recorded'
    )
    assertEquals(
      await recordTopologyGeneration(db, serverId, { ...first, snapshot: { memory: 2 } }),
      'refreshed'
    )
    assertEquals(
      await recordTopologyGeneration(db, serverId, { ...first, snapshot: { memory: 2 } }),
      'refreshed'
    )
    assertEquals(await topologyRowCount(db, serverId), 1)
    assertEquals((await getTopologyGeneration(db, serverId, 4))?.snapshot, { memory: 2 })
  })
})

test('the latest topology is the newest recorded row, so a forged huge number cannot pin itself', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, {
      generation: 2_000_000_000,
      bootGeneration: 0,
      snapshot: { forged: true },
      appliedAt: REPORT_AT,
    })
    await recordTopologyGeneration(db, serverId, {
      generation: 3,
      bootGeneration: 0,
      snapshot: { honest: true },
      appliedAt: REPORT_AT,
    })
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.snapshot, { honest: true })
  })
})

test('only the newest rows are kept per server as new generations arrive', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    const hourMs = 60 * 60 * 1000
    const total = MAX_RETAINED_TOPOLOGY_GENERATIONS + 50
    await db.insert(topologyGeneration).values(
      Array.from({ length: total }, (_, i) => ({
        serverId,
        generation: i,
        bootGeneration: 0,
        snapshot: { i },
        appliedAt: REPORT_AT,
        // Older than the hourly window, oldest first.
        createdAt: new Date(Date.now() - (total - i + 2) * hourMs).toISOString(),
      }))
    )
    assertEquals(
      await recordTopologyGeneration(db, serverId, {
        generation: 10_000,
        bootGeneration: 0,
        snapshot: { newest: true },
        appliedAt: REPORT_AT,
      }),
      'recorded'
    )
    assertEquals(await topologyRowCount(db, serverId), MAX_RETAINED_TOPOLOGY_GENERATIONS)
    assertEquals((await getTopologyGeneration(db, serverId, 10_000))?.snapshot, { newest: true })
    assertEquals(await getTopologyGeneration(db, serverId, 0), undefined)
    assert((await getTopologyGeneration(db, serverId, total - 1)) !== undefined)
  })
})
