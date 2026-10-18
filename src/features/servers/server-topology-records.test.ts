import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import {
  getLatestTopologyGeneration,
  getLatestTopologyGenerations,
  getTopologyGeneration,
  getTopologyGenerations,
  layoutPathsFromSnapshot,
  MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY,
  MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR,
  recordTopologyGeneration,
  resetTopologyChurnLogForTests,
} from './server-topology-records.ts'
import { isMachineKeyInUse, touchServerMetadata } from './server-registry.ts'

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

test('getLatestTopologyGeneration returns the last recorded generation', async () => {
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
      await db.delete(server).where(eq(server.id, serverId!))
    }
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

test('getLatestTopologyGenerations returns the last generation per server in one query, omitting servers with none recorded', async () => {
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

test('getTopologyGeneration answers only for the stored generation: older ones are not kept', async () => {
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

    const current = await getTopologyGeneration(db, serverId, 2)
    assertEquals(current?.generation, 2)
    assertEquals(current?.snapshot, { devices: ['nic-a', 'nic-b'] })
    assertEquals(Date.parse(current?.appliedAt ?? ''), Date.parse('2026-01-01T00:05:00.000Z'))

    // The first generation was overwritten; a sample naming it reads as unknown.
    assertEquals(await getTopologyGeneration(db, serverId, 1), undefined)
    assertEquals(await getTopologyGeneration(db, serverId, 99), undefined)
    assertEquals([...(await getTopologyGenerations(db, serverId, [1, 2])).keys()], [2])
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

    const record = await getTopologyGeneration(db, serverId, 1)
    assertEquals(record?.snapshot, { devices: ['nic-a'] })
    // The second call's appliedAt is dropped along with the rest of its report.
    assertEquals(Date.parse(record?.appliedAt ?? ''), Date.parse('2026-01-01T00:00:00.000Z'))
  })
})

const REPORT_AT = '2026-01-01T00:00:00.000Z'

type TestDb = ReturnType<typeof createDenoDb>

/** How many generation changes the server has on record (the limit counters). */
async function topologyRowCount(db: TestDb, serverId: string): Promise<number> {
  const [row] = await db
    .select({ hardware: server.hardware })
    .from(server)
    .where(eq(server.id, serverId))
  const changes = (row?.hardware as { changes?: unknown[] } | null)?.changes
  return changes?.length ?? 0
}

async function serverMetadata(db: TestDb, serverId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
  return row!.metadata as Record<string, unknown>
}

/** Pretend everything this server has written so far was written `hours` ago. */
async function ageRows(db: TestDb, serverId: string, hours: number): Promise<void> {
  await db.execute(sql`
    UPDATE server SET hardware = jsonb_set(
      jsonb_set(
        hardware,
        '{updatedAt}',
        to_jsonb(((hardware ->> 'updatedAt')::timestamptz - make_interval(hours => ${hours}))::text)
      ),
      '{changes}',
      COALESCE((
        SELECT jsonb_agg(to_jsonb(((c #>> '{}')::timestamptz - make_interval(hours => ${hours}))::text))
        FROM jsonb_array_elements(hardware -> 'changes') AS c
      ), '[]'::jsonb)
    )
    WHERE id = ${serverId}::uuid AND hardware IS NOT NULL
  `)
}

function report(generation: number, extra: { snapshot?: unknown; bootGeneration?: number } = {}) {
  return {
    generation,
    bootGeneration: extra.bootGeneration ?? 0,
    snapshot: extra.snapshot ?? { generation },
    appliedAt: REPORT_AT,
  }
}

test('a flood of fake generation numbers cannot change the stored generation past the hourly limit', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const outcomes: string[] = []
    for (let i = 0; i < 200; i++) {
      outcomes.push(
        await recordTopologyGeneration(db, serverId, {
          // Distinct, scattered numbers and a fat snapshot each: the worst a daemon can send.
          ...report(1000 + i * 7919, { snapshot: { pad: 'x'.repeat(2000), i }, bootGeneration: i }),
        })
      )
    }
    assertEquals(await topologyRowCount(db, serverId), MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR)
    assertEquals(
      outcomes.filter((o) => o === 'recorded').length,
      MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR
    )
    assertEquals(
      outcomes.filter((o) => o === 'rate_limited').length,
      200 - MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR
    )
    assert(
      typeof (await serverMetadata(db, serverId)).topologyChurnLimitedAt === 'string',
      'the limit hit is stamped as a durable alert'
    )
  })
})

test('parallel reports cannot slip past the hourly limit together', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const outcomes = await Promise.all(
      Array.from({ length: 60 }, (_, i) => recordTopologyGeneration(db, serverId, report(10 + i)))
    )
    assertEquals(await topologyRowCount(db, serverId), MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR)
    assertEquals(
      outcomes.filter((o) => o === 'recorded').length,
      MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR
    )
  })
})

test('the daily limit holds even when the hourly window keeps freeing up', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    let recorded = 0
    for (let hour = 0; hour < 10; hour++) {
      for (let i = 0; i < 12; i++) {
        const outcome = await recordTopologyGeneration(db, serverId, report(hour * 100 + i))
        if (outcome === 'recorded') recorded++
      }
      // An hour passes: the hourly window is clear again, the daily one is not.
      await ageRows(db, serverId, 1)
    }
    assertEquals(recorded, MAX_NEW_TOPOLOGY_GENERATIONS_PER_DAY)
  })
})

test('generation numbers the table cannot hold are rejected and write nothing', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    for (const generation of [2_147_483_648, 1e300, -1, 1.5, Number.NaN]) {
      assertEquals(await recordTopologyGeneration(db, serverId, report(generation)), 'rejected')
    }
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(1, { bootGeneration: 2_147_483_648 })),
      'rejected'
    )
    assertEquals(await topologyRowCount(db, serverId), 0)
  })
})

test('an identical resend writes nothing, and a rewrite inside the cooldown is ignored', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(4, { snapshot: { memory: 1 } })),
      'recorded'
    )
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(4, { snapshot: { memory: 1 } })),
      'unchanged'
    )
    // A different snapshot straight away is inside the cooldown: no write.
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(4, { snapshot: { memory: 2 } })),
      'unchanged'
    )
    assertEquals((await getTopologyGeneration(db, serverId, 4))?.snapshot, { memory: 1 })
    assertEquals(await topologyRowCount(db, serverId), 1)
  })
})

test('after the cooldown, a resend of the newest generation refreshes its snapshot in place', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, report(4, { snapshot: { paths: 'old' } }))
    await ageRows(db, serverId, 1)
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(4, { snapshot: { paths: 'new' } })),
      'refreshed'
    )
    assertEquals((await getTopologyGeneration(db, serverId, 4))?.snapshot, { paths: 'new' })
    assertEquals(await topologyRowCount(db, serverId), 1)
  })
})

test('an honest daemon reporting its own generation replaces a forged huge one', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(db, serverId, report(3, { snapshot: { honest: true } }))
    await recordTopologyGeneration(
      db,
      serverId,
      report(2_000_000_000, { snapshot: { forged: true } })
    )
    await ageRows(db, serverId, 1)
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(3, { snapshot: { honest: true } })),
      'recorded'
    )
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.generation, 3)
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.snapshot, { honest: true })
    assertEquals(await topologyRowCount(db, serverId), 3)
  })
})

test('the latest topology is the newest recorded row, so a forged huge number cannot pin itself', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyGeneration(
      db,
      serverId,
      report(2_000_000_000, { snapshot: { forged: true } })
    )
    await recordTopologyGeneration(db, serverId, report(3, { snapshot: { honest: true } }))
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.snapshot, { honest: true })
  })
})

test('the stored value never keeps more than a day of change times, so it stays small', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    for (let i = 0; i < MAX_NEW_TOPOLOGY_GENERATIONS_PER_HOUR; i++) {
      await recordTopologyGeneration(
        db,
        serverId,
        report(10 + i, { snapshot: { pad: 'x'.repeat(100) } })
      )
    }
    await ageRows(db, serverId, 25)
    assertEquals(await recordTopologyGeneration(db, serverId, report(500)), 'recorded')
    assertEquals(await topologyRowCount(db, serverId), 1)
  })
})

test('honest recovery: once the limit has room again the next report is recorded and the alert clears', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    for (let i = 0; i < 14; i++) await recordTopologyGeneration(db, serverId, report(100 + i))
    assert('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)))
    assertEquals(await recordTopologyGeneration(db, serverId, report(500)), 'rate_limited')

    // A day later the hourly and daily windows are both clear.
    await ageRows(db, serverId, 25)
    assertEquals(await recordTopologyGeneration(db, serverId, report(500)), 'recorded')
    assertEquals('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)), false)
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.generation, 500)
  })
})

test('the churn alert stamp is not rewritten on every refused report', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    for (let i = 0; i < 13; i++) await recordTopologyGeneration(db, serverId, report(100 + i))
    const first = (await serverMetadata(db, serverId)).topologyChurnLimitedAt
    assert(typeof first === 'string')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await recordTopologyGeneration(db, serverId, report(999))
    assertEquals((await serverMetadata(db, serverId)).topologyChurnLimitedAt, first)
  })
})

test('a machine key belongs to one server: a second row with it is refused with the machine-key error', async () => {
  await withTwoServerFixture(async ({ db, serverIdA, serverIdB }) => {
    const machineKey = `mk-${crypto.randomUUID()}`
    await db.update(server).set({ machineKey }).where(eq(server.id, serverIdA))
    let caught: unknown
    try {
      await db.update(server).set({ machineKey }).where(eq(server.id, serverIdB))
    } catch (err) {
      caught = err
    }
    assert(isMachineKeyInUse(caught), 'the unique violation names the machine key constraint')
    // Servers without a machine key never clash with each other.
    await db.update(server).set({ machineKey: null }).where(eq(server.id, serverIdA))
  })
})

test('a hello that reports a machine key another server holds still lands its other facts', async () => {
  await withTwoServerFixture(async ({ db, serverIdA, serverIdB }) => {
    const machineKey = `mk-${crypto.randomUUID()}`
    await db.update(server).set({ machineKey }).where(eq(server.id, serverIdA))
    await touchServerMetadata(db, serverIdB, { hostname: 'moved-host', machineKey })
    const [row] = await db
      .select({ hostname: server.hostname, machineKey: server.machineKey })
      .from(server)
      .where(eq(server.id, serverIdB))
    assertEquals(row?.hostname, 'moved-host')
    assertEquals(row?.machineKey, null)
  })
})
