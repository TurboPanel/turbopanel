import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  computeMetricsCapabilityPlanHash,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
} from '../../contracts/capability-plan.ts'
import { recordCapabilityPlanGenerationIfChanged } from './capability-plan-records.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

type Counters = { selects: number; transactions: number }

/** Minimal Db double: counts selects and transactions, answers with `latest`. */
function countingDb(latest: unknown[]): { db: Db; counters: Counters } {
  const counters: Counters = { selects: 0, transactions: 0 }
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(latest),
  }
  const db = {
    select: () => {
      counters.selects += 1
      return chain
    },
    transaction: () => {
      counters.transactions += 1
      return Promise.reject(new Error('locking transaction must not run'))
    },
  } as unknown as Db
  return { db, counters }
}

test('unchanged plan costs one unlocked read and no transaction', async () => {
  const plan = PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN
  const planHash = await computeMetricsCapabilityPlanHash(plan)
  const { db, counters } = countingDb([
    { generation: 7, planHash, plan, appliedAt: new Date().toISOString() },
  ])
  for (let i = 0; i < 20; i += 1) {
    const written = await recordCapabilityPlanGenerationIfChanged(
      db,
      '00000000-0000-0000-0000-000000000001',
      plan
    )
    assertEquals(written, { generation: 7, changed: false })
  }
  // Before the fix every call ran BEGIN + FOR UPDATE + SELECT + COMMIT.
  assertEquals(counters.transactions, 0)
  assertEquals(counters.selects, 20)
})

test('a changed plan still takes the locking transaction', async () => {
  const { db, counters } = countingDb([
    {
      generation: 1,
      planHash: 'different',
      plan: {},
      appliedAt: new Date().toISOString(),
    },
  ])
  let failed = false
  try {
    await recordCapabilityPlanGenerationIfChanged(
      db,
      '00000000-0000-0000-0000-000000000001',
      PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN
    )
  } catch {
    failed = true
  }
  assertEquals(failed, true)
  assertEquals(counters.transactions, 1)
})
