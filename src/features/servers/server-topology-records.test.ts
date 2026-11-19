import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { organization, server } from '../../db/schema.ts'
import {
  getLatestServerTopology,
  getLatestServerTopologies,
  layoutPathsFromSnapshot,
  MAX_TOPOLOGY_CHANGES_PER_DAY,
  MAX_TOPOLOGY_CHANGES_PER_HOUR,
  recordTopologyReport,
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

/** A snapshot that names its uplinks, so two lists of ids are two topologies. */
function nicSnapshot(nics: string[]) {
  return { networks: nics.map((deviceId) => ({ deviceId, kind: 'uplink' })) }
}

test('layoutPathsFromSnapshot reads a v6 snapshot and answers null for older or malformed ones', () => {
  assertEquals(
    layoutPathsFromSnapshot({
      paths: { backup: '/mnt/nas/backups', logs: '/var/log/turbopanel' },
    }),
    { backup: '/mnt/nas/backups', logs: '/var/log/turbopanel' }
  )
  // Pre-v6 daemon: no `paths` at all.
  assertEquals(layoutPathsFromSnapshot({ hardwareSignals: [] }), null)
  // Half a record is no record.
  assertEquals(layoutPathsFromSnapshot({ paths: { backup: '/backup' } }), null)
  assertEquals(
    layoutPathsFromSnapshot({ paths: { backup: '', logs: '/var/log/turbopanel' } }),
    null
  )
  assertEquals(layoutPathsFromSnapshot(null), null)
  assertEquals(layoutPathsFromSnapshot([]), null)
})

test('getLatestServerTopology returns the last recorded topology', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyReport(db, serverId, {
      snapshot: nicSnapshot(['nic-a']),
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyReport(db, serverId, {
      snapshot: nicSnapshot(['nic-a', 'nic-b']),
      appliedAt: '2026-01-01T00:05:00.000Z',
    })

    const latest = await getLatestServerTopology(db, serverId)
    // The daemon-reported object is stored directly — never wrapped.
    assertEquals(latest?.snapshot, nicSnapshot(['nic-a', 'nic-b']))
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

test('getLatestServerTopologies returns the last topology per server in one query, omitting servers with none recorded', async () => {
  await withTwoServerFixture(async ({ db, serverIdA, serverIdB, serverIdC }) => {
    await recordTopologyReport(db, serverIdA, {
      snapshot: nicSnapshot(['a-gen1']),
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    await recordTopologyReport(db, serverIdA, {
      snapshot: nicSnapshot(['a-gen2']),
      appliedAt: '2026-01-01T00:05:00.000Z',
    })
    await recordTopologyReport(db, serverIdB, {
      snapshot: nicSnapshot(['b-gen1']),
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    // serverIdC deliberately has no recorded generation.

    const byServer = await getLatestServerTopologies(db, [serverIdA, serverIdB, serverIdC])
    assertEquals(byServer.size, 2)
    assertEquals(byServer.get(serverIdA)?.snapshot, nicSnapshot(['a-gen2']))
    assertEquals(byServer.get(serverIdB)?.snapshot, nicSnapshot(['b-gen1']))
    assertEquals(byServer.has(serverIdC), false)
  })
})

test('getLatestServerTopologies returns an empty map for an empty serverIds list without querying', async () => {
  await withTwoServerFixture(async ({ db }) => {
    const byServer = await getLatestServerTopologies(db, [])
    assertEquals(byServer.size, 0)
  })
})

test('recordTopologyReport is idempotent for a repeated topology', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyReport(db, serverId, {
      snapshot: nicSnapshot(['nic-a']),
      appliedAt: '2026-01-01T00:00:00.000Z',
    })
    // Simulates the daemon resending an unchanged topology on reconnect.
    await recordTopologyReport(db, serverId, {
      snapshot: { ...nicSnapshot(['nic-a']), pad: 'should-not-be-recorded' },
      appliedAt: '2026-01-01T00:10:00.000Z',
    })

    const record = await getLatestServerTopology(db, serverId)
    assertEquals(record?.snapshot, nicSnapshot(['nic-a']))
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

/** A report whose topology differs with `n`: one uplink named after it. */
function report(n: number, extra: { snapshot?: unknown } = {}) {
  return {
    snapshot: extra.snapshot ?? nicSnapshot([`nic-${n}`]),
    appliedAt: REPORT_AT,
  }
}

test('a flood of different topologies cannot change the stored topology past the hourly limit', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const outcomes: string[] = []
    for (let i = 0; i < 200; i++) {
      outcomes.push(
        await recordTopologyReport(db, serverId, {
          // A distinct topology and a fat snapshot each: the worst a daemon can send.
          ...report(i, { snapshot: { ...nicSnapshot([`nic-${i}`]), pad: 'x'.repeat(2000) } }),
        })
      )
    }
    assertEquals(await topologyRowCount(db, serverId), MAX_TOPOLOGY_CHANGES_PER_HOUR)
    assertEquals(outcomes.filter((o) => o === 'recorded').length, MAX_TOPOLOGY_CHANGES_PER_HOUR)
    assertEquals(
      outcomes.filter((o) => o === 'rate_limited').length,
      200 - MAX_TOPOLOGY_CHANGES_PER_HOUR
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
      Array.from({ length: 60 }, (_, i) => recordTopologyReport(db, serverId, report(10 + i)))
    )
    assertEquals(await topologyRowCount(db, serverId), MAX_TOPOLOGY_CHANGES_PER_HOUR)
    assertEquals(outcomes.filter((o) => o === 'recorded').length, MAX_TOPOLOGY_CHANGES_PER_HOUR)
  })
})

test('the daily limit holds even when the hourly window keeps freeing up', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    let recorded = 0
    for (let hour = 0; hour < 10; hour++) {
      for (let i = 0; i < 12; i++) {
        const outcome = await recordTopologyReport(db, serverId, report(hour * 100 + i))
        if (outcome === 'recorded') recorded++
      }
      // An hour passes: the hourly window is clear again, the daily one is not.
      await ageRows(db, serverId, 1)
    }
    assertEquals(recorded, MAX_TOPOLOGY_CHANGES_PER_DAY)
  })
})

test('an identical resend writes nothing, and a rewrite inside the cooldown is ignored', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    assertEquals(
      await recordTopologyReport(db, serverId, report(4, { snapshot: { memory: 1 } })),
      'recorded'
    )
    assertEquals(
      await recordTopologyReport(db, serverId, report(4, { snapshot: { memory: 1 } })),
      'unchanged'
    )
    // A different snapshot straight away is inside the cooldown: no write.
    assertEquals(
      await recordTopologyReport(db, serverId, report(4, { snapshot: { memory: 2 } })),
      'unchanged'
    )
    assertEquals((await getLatestServerTopology(db, serverId))?.snapshot, { memory: 1 })
    assertEquals(await topologyRowCount(db, serverId), 1)
  })
})

test('after the cooldown, a resend of the stored topology refreshes its snapshot in place', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    await recordTopologyReport(db, serverId, report(4, { snapshot: { paths: 'old' } }))
    await ageRows(db, serverId, 1)
    assertEquals(
      await recordTopologyReport(db, serverId, report(4, { snapshot: { paths: 'new' } })),
      'refreshed'
    )
    assertEquals((await getLatestServerTopology(db, serverId))?.snapshot, { paths: 'new' })
    assertEquals(await topologyRowCount(db, serverId), 1)
  })
})

test('the stored value never keeps more than a day of change times, so it stays small', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    for (let i = 0; i < MAX_TOPOLOGY_CHANGES_PER_HOUR; i++) {
      await recordTopologyReport(
        db,
        serverId,
        report(10 + i, { snapshot: { pad: 'x'.repeat(100) } })
      )
    }
    await ageRows(db, serverId, 25)
    assertEquals(await recordTopologyReport(db, serverId, report(500)), 'recorded')
    assertEquals(await topologyRowCount(db, serverId), 1)
  })
})

test('honest recovery: once the limit has room again the next report is recorded and the alert clears', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    for (let i = 0; i < 14; i++) await recordTopologyReport(db, serverId, report(100 + i))
    assert('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)))
    assertEquals(await recordTopologyReport(db, serverId, report(500)), 'rate_limited')

    // A day later the hourly and daily windows are both clear.
    await ageRows(db, serverId, 25)
    assertEquals(await recordTopologyReport(db, serverId, report(500)), 'recorded')
    assertEquals('topologyChurnLimitedAt' in (await serverMetadata(db, serverId)), false)
    assertEquals((await getLatestServerTopology(db, serverId))?.snapshot, report(500).snapshot)
  })
})

test('the churn alert stamp is not rewritten on every refused report', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    for (let i = 0; i < 13; i++) await recordTopologyReport(db, serverId, report(100 + i))
    const first = (await serverMetadata(db, serverId)).topologyChurnLimitedAt
    assert(typeof first === 'string')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await recordTopologyReport(db, serverId, report(999))
    assertEquals((await serverMetadata(db, serverId)).topologyChurnLimitedAt, first)
  })
})

/** A report as a daemon sends it once the control plane no longer needs generation numbers. */
function numberlessReport(nics: string[], extra: Record<string, unknown> = {}) {
  return {
    snapshot: { networks: nics.map((deviceId) => ({ deviceId, kind: 'uplink' })), ...extra },
    appliedAt: REPORT_AT,
  }
}

test('the same topology is a resend and a different one is a change', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    assertEquals(await recordTopologyReport(db, serverId, numberlessReport(['eth0'])), 'recorded')
    assertEquals(await recordTopologyReport(db, serverId, numberlessReport(['eth0'])), 'unchanged')
    // Sizes and labels are not topology: after the cooldown they refresh in place.
    await ageRows(db, serverId, 1)
    assertEquals(
      await recordTopologyReport(db, serverId, numberlessReport(['eth0'], { memoryTotalBytes: 1 })),
      'refreshed'
    )
    assertEquals(await topologyRowCount(db, serverId), 1)
    // A new NIC is a new topology and counts against the limits.
    assertEquals(
      await recordTopologyReport(db, serverId, numberlessReport(['eth0', 'eth1'])),
      'recorded'
    )
    assertEquals(await topologyRowCount(db, serverId), 2)
    const latest = await getLatestServerTopology(db, serverId)
    assertEquals(latest?.snapshot, numberlessReport(['eth0', 'eth1']).snapshot)
  })
})

test('a flood of different topologies still stops at the hourly limit', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    resetTopologyChurnLogForTests()
    const outcomes: string[] = []
    for (let i = 0; i < 40; i++) {
      outcomes.push(await recordTopologyReport(db, serverId, numberlessReport([`nic-${i}`])))
    }
    assertEquals(outcomes.filter((o) => o === 'recorded').length, MAX_TOPOLOGY_CHANGES_PER_HOUR)
    assertEquals(await topologyRowCount(db, serverId), MAX_TOPOLOGY_CHANGES_PER_HOUR)
  })
})

test('generation numbers an older daemon still sends are ignored and never stored', async () => {
  await withServerFixture(async ({ db, serverId }) => {
    const withNumbers = { ...numberlessReport(['eth0']), generation: 4, bootGeneration: 2 }
    assertEquals(await recordTopologyReport(db, serverId, withNumbers), 'recorded')
    const [row] = await db
      .select({ hardware: server.hardware })
      .from(server)
      .where(eq(server.id, serverId))
    const stored = row?.hardware as Record<string, unknown>
    assertEquals('generation' in stored, false)
    assertEquals('bootGeneration' in stored, false)
    // The same topology resent with different numbers is a resend, not a change.
    const renumbered = { ...numberlessReport(['eth0']), generation: 9, bootGeneration: 3 }
    assertEquals(await recordTopologyReport(db, serverId, renumbered), 'unchanged')
    assertEquals(await topologyRowCount(db, serverId), 1)
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
