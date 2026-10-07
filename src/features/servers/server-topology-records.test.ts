import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import { recordOverPlan } from '../../daemon/metrics/over-plan-flag.ts'
import { serverMetadataWithoutHardware } from './server-metadata-select.ts'
import {
  getLatestTopologyGeneration,
  getLatestTopologyGenerations,
  layoutPathsFromSnapshot,
  markTopologyResyncRequested,
  recordTopologyGeneration,
  resetTopologyChurnLogForTests,
  TOPOLOGY_REWRITE_COOLDOWN_SECONDS,
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

const REPORT_AT = '2026-01-01T00:00:00.000Z'

type TestDb = ReturnType<typeof createDenoDb>

/** How many `hardware` keys the server's metadata holds (0 or 1: there is nowhere to keep a history). */
async function hardwareKeyCount(db: TestDb, serverId: string): Promise<number> {
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
  return (row?.metadata as Record<string, unknown> | null)?.hardware === undefined ? 0 : 1
}

async function serverMetadata(db: TestDb, serverId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: server.metadata })
    .from(server)
    .where(eq(server.id, serverId))
  return row!.metadata as Record<string, unknown>
}

/** Pretend this server's hardware facts were last written `seconds` earlier than they were. */
async function ageHardware(db: TestDb, serverId: string, seconds: number): Promise<void> {
  await db.execute(sql`
    UPDATE server
    SET metadata = jsonb_set(
      metadata,
      '{hardware,updatedAt}',
      to_jsonb(((metadata -> 'hardware' ->> 'updatedAt')::timestamptz - make_interval(secs => ${seconds})))
    )
    WHERE id = ${serverId}::uuid
  `)
}

/** Just past the overwrite cooldown. */
const PAST_COOLDOWN_SECONDS = TOPOLOGY_REWRITE_COOLDOWN_SECONDS + 1

function report(generation: number, extra: { snapshot?: unknown; bootGeneration?: number } = {}) {
  return {
    generation,
    bootGeneration: extra.bootGeneration ?? 0,
    snapshot: extra.snapshot ?? { generation },
    appliedAt: REPORT_AT,
  }
}

test('the latest hardware facts overwrite the previous ones once the cooldown has passed', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    assertEquals(
      await recordTopologyGeneration(db, serverId, {
        generation: 1,
        bootGeneration: 1,
        snapshot: { devices: ['nic-a'] },
        appliedAt: '2026-01-01T00:00:00.000Z',
      }),
      'recorded'
    )
    await ageHardware(db, serverId, PAST_COOLDOWN_SECONDS)
    assertEquals(
      await recordTopologyGeneration(db, serverId, {
        generation: 2,
        bootGeneration: 1,
        snapshot: { devices: ['nic-a', 'nic-b'] },
        appliedAt: '2026-01-01T00:05:00.000Z',
      }),
      'refreshed'
    )

    assertEquals(await hardwareKeyCount(db, serverId), 1)
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

test('getLatestTopologyGenerations returns the latest facts per server in one query, omitting servers with none', async () => {
  await withTwoServerFixture(async ({ db, serverIdA, serverIdB, serverIdC }) => {
    await recordTopologyGeneration(db, serverIdA, report(1, { snapshot: { devices: ['a-gen1'] } }))
    await ageHardware(db, serverIdA, PAST_COOLDOWN_SECONDS)
    await recordTopologyGeneration(db, serverIdA, report(2, { snapshot: { devices: ['a-gen2'] } }))
    await recordTopologyGeneration(db, serverIdB, report(1, { snapshot: { devices: ['b-gen1'] } }))
    // serverIdC deliberately has no facts.

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

test('a flood of reports keeps one record per server and changes it at most once per cooldown', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const outcomes: string[] = []
    for (let i = 0; i < 200; i++) {
      outcomes.push(await recordTopologyGeneration(db, serverId, report(100 + i)))
    }
    assertEquals(outcomes[0], 'recorded')
    assertEquals(
      outcomes.slice(1).every((outcome) => outcome === 'rate_limited'),
      true
    )
    assertEquals(await hardwareKeyCount(db, serverId), 1)
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.generation, 100)
    assert('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)))
  })
})

test('parallel reports still leave one record', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => recordTopologyGeneration(db, serverId, report(i)))
    )
    assertEquals(outcomes.filter((outcome) => outcome === 'recorded').length, 1)
    assertEquals(await hardwareKeyCount(db, serverId), 1)
  })
})

test('generation numbers the table cannot hold are rejected and write nothing', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    assertEquals(await recordTopologyGeneration(db, serverId, report(2 ** 31)), 'rejected')
    assertEquals(await recordTopologyGeneration(db, serverId, report(-1)), 'rejected')
    assertEquals(await recordTopologyGeneration(db, serverId, report(1.5)), 'rejected')
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(1, { bootGeneration: 2 ** 31 })),
      'rejected'
    )
    assertEquals(await hardwareKeyCount(db, serverId), 0)
  })
})

test('an identical resend writes nothing, even after the cooldown', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    assertEquals(await recordTopologyGeneration(db, serverId, report(4)), 'recorded')
    assertEquals(await recordTopologyGeneration(db, serverId, report(4)), 'unchanged')
    await ageHardware(db, serverId, PAST_COOLDOWN_SECONDS)
    assertEquals(await recordTopologyGeneration(db, serverId, report(4)), 'unchanged')
    assertEquals('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)), false)
  })
})

test('a changed snapshot under the same generation counts as a change', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    await recordTopologyGeneration(db, serverId, report(4, { snapshot: { paths: 'old' } }))
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(4, { snapshot: { paths: 'new' } })),
      'rate_limited'
    )
    await ageHardware(db, serverId, PAST_COOLDOWN_SECONDS)
    assertEquals(
      await recordTopologyGeneration(db, serverId, report(4, { snapshot: { paths: 'new' } })),
      'refreshed'
    )
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.snapshot, { paths: 'new' })
  })
})

test('honest recovery: after the cooldown the next report is stored and the alert clears', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    await recordTopologyGeneration(db, serverId, report(100))
    assertEquals(await recordTopologyGeneration(db, serverId, report(101)), 'rate_limited')
    assert('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)))

    await ageHardware(db, serverId, PAST_COOLDOWN_SECONDS)
    assertEquals(await recordTopologyGeneration(db, serverId, report(500)), 'refreshed')
    assertEquals('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)), false)
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.generation, 500)
  })
})

test('the churn alert stamp is not rewritten on every refused report', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    await recordTopologyGeneration(db, serverId, report(100))
    await recordTopologyGeneration(db, serverId, report(101))
    const first = (await serverMetadata(db, serverId)).topologyChurnLimitedAt
    assert(typeof first === 'string')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await recordTopologyGeneration(db, serverId, report(999))
    assertEquals((await serverMetadata(db, serverId)).topologyChurnLimitedAt, first)
  })
})

test('writers of different metadata keys never overwrite each other, however they interleave', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const GIB = 1024 ** 3
    await db
      .update(server)
      .set({ metadata: { resources: { memory: { totalBytes: 8 * GIB } } } })
      .where(eq(server.id, serverId))
    const setResources = (round: number) =>
      db.execute(sql`
        UPDATE server
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{docker}', ${JSON.stringify({ round })}::jsonb)
        WHERE id = ${serverId}::uuid
      `)
    for (let round = 0; round < 12; round++) {
      if (round > 0) await ageHardware(db, serverId, PAST_COOLDOWN_SECONDS)
      await Promise.all([
        recordTopologyGeneration(db, serverId, report(round)),
        recordOverPlan(db, serverId, 1, 64 * GIB, {}),
        markTopologyResyncRequested(db, serverId),
        setResources(round),
      ])
      const metadata = await serverMetadata(db, serverId)
      assertEquals(
        Object.keys(metadata).sort(),
        ['docker', 'hardware', 'overPlan', 'resources', 'topologyResyncRequestedAt'],
        `round ${round}: a writer lost another writer's key`
      )
      assertEquals((metadata.docker as { round: number }).round, round)
      assertEquals((metadata.hardware as { generation: number }).generation, round)
    }
  })
})

test('every other reader of server.metadata is handed the metadata without the hardware snapshot', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await db
      .update(server)
      .set({ metadata: { resources: { memory: { totalBytes: 1 } } } })
      .where(eq(server.id, serverId))
    await recordTopologyGeneration(db, serverId, report(1, { snapshot: { big: 'x'.repeat(2000) } }))
    const [lean] = await db
      .select({ metadata: serverMetadataWithoutHardware })
      .from(server)
      .where(eq(server.id, serverId))
    assertEquals(lean?.metadata, { resources: { memory: { totalBytes: 1 } } })
    // The one reader of the key still gets it.
    assertEquals((await getLatestTopologyGeneration(db, serverId))?.generation, 1)
  })
})
