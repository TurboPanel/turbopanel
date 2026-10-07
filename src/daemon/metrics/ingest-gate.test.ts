import { assert, assertEquals } from '@std/assert'
import { eq, sql } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { metricsGate, organization, server } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import {
  admitMetricsSample,
  GATE_EVENTS_PER_HOUR,
  GATE_SAMPLE_BURST,
  type GateDecision,
} from './ingest-gate.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
type TestDb = ReturnType<typeof createDenoDb>

async function withServer(fn: (db: TestDb, serverId: string) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('metrics ingest gate tests')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Metrics Gate Org' })
    .returning({ id: organization.id })
  const [row] = await db
    .insert(server)
    .values({ organizationId: org!.id, name: 'Metrics Gate Server' })
    .returning({ id: server.id })
  try {
    await fn(db, row!.id)
  } finally {
    await db.delete(server).where(eq(server.id, row!.id))
    await db.delete(organization).where(eq(organization.id, org!.id))
  }
}

const T0 = Date.parse('2026-10-07T12:00:00.000Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

/** Pretend the gate's counters were last refreshed `seconds` ago (token refill). */
async function age(db: TestDb, serverId: string, seconds: number): Promise<void> {
  await db.execute(sql`
    UPDATE gate SET refreshed_at = refreshed_at - make_interval(secs => ${seconds})
    WHERE server_id = ${serverId}::uuid
  `)
}

function stored(decision: GateDecision): boolean {
  return decision.stored
}

test('the first sample is stored, the same timestamp again is a duplicate, an earlier one a replay', async () => {
  await withServer(async (db, serverId) => {
    assertEquals(await admitMetricsSample(db, serverId, at(0), 0), {
      stored: true,
      eventsAllowed: 0,
    })
    const again = await admitMetricsSample(db, serverId, at(0), 0)
    assertEquals(again.stored, false)
    if (!again.stored) assertEquals(again.reason, 'duplicate')
    const replay = await admitMetricsSample(db, serverId, at(-60), 0)
    assertEquals(replay.stored, false)
    if (!replay.stored) assertEquals(replay.reason, 'duplicate')
  })
})

test('a sample a minute after the last is stored without spending the catch-up allowance', async () => {
  await withServer(async (db, serverId) => {
    for (let minute = 0; minute < 30; minute++) {
      assert(stored(await admitMetricsSample(db, serverId, at(minute * 60), 0)), `minute ${minute}`)
    }
    const [row] = await db.select().from(metricsGate).where(eq(metricsGate.serverId, serverId))
    assertEquals(row!.sampleTokens, GATE_SAMPLE_BURST)
  })
})

test('early samples spend the catch-up allowance, then are refused with a Retry-After', async () => {
  await withServer(async (db, serverId) => {
    const decisions: GateDecision[] = []
    for (let i = 0; i < 20; i++) {
      decisions.push(await admitMetricsSample(db, serverId, at(i * 2), 0))
    }
    // The first sample, plus the burst of early ones; the rest are refused.
    assertEquals(decisions.filter(stored).length, 1 + GATE_SAMPLE_BURST)
    const refused = decisions.at(-1)!
    assertEquals(refused.stored, false)
    if (!refused.stored) {
      assertEquals(refused.reason, 'too_soon')
      assert(refused.retryAfterSeconds >= 1 && refused.retryAfterSeconds <= 60)
    }
  })
})

test('the catch-up allowance refills one sample a minute', async () => {
  await withServer(async (db, serverId) => {
    for (let i = 0; i <= GATE_SAMPLE_BURST; i++) await admitMetricsSample(db, serverId, at(i), 0)
    assertEquals(stored(await admitMetricsSample(db, serverId, at(10), 0)), false)
    await age(db, serverId, 61)
    assertEquals(stored(await admitMetricsSample(db, serverId, at(11), 0)), true)
  })
})

test('a flood of parallel samples for the same minute stores at most the first plus the burst', async () => {
  await withServer(async (db, serverId) => {
    const decisions = await Promise.all(
      Array.from({ length: 60 }, (_, i) => admitMetricsSample(db, serverId, at(i), 0))
    )
    assert(decisions.filter(stored).length <= 1 + GATE_SAMPLE_BURST)
  })
})

test('events are stored while the hourly budget lasts, then dropped; the sample itself is still stored', async () => {
  await withServer(async (db, serverId) => {
    let allowed = 0
    for (let minute = 0; minute < 10; minute++) {
      const decision = await admitMetricsSample(db, serverId, at(minute * 60), 16)
      assert(decision.stored)
      if (decision.stored) allowed += decision.eventsAllowed
    }
    // 10 samples of 16 events is 160, against a budget of 120 an hour (plus the trickle refill).
    assert(allowed >= GATE_EVENTS_PER_HOUR && allowed < 130, `allowed ${allowed}`)
    const last = await admitMetricsSample(db, serverId, at(600), 16)
    assert(last.stored)
    if (last.stored) assert(last.eventsAllowed < 16)
  })
})
