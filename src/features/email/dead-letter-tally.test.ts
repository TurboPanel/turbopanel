import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'
import {
  countEmailDeadLetters,
  EMAIL_DEAD_LETTER_TALLY_KEY,
  recordEmailDeadLetter,
  sumTally,
} from './dead-letter-tally.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = Date.parse('2026-11-04T12:00:00.000Z')
const DAY = 86_400_000

test('sumTally counts only the last four days and ignores anything malformed', () => {
  const value = {
    '2026-11-04': 2,
    '2026-11-01': 1,
    '2026-10-31': 5,
    '2026-11-03': -1,
    '2026-11-02': 'x',
  }
  assertEquals(sumTally(value, NOW), 3)
  assertEquals(sumTally(null, NOW), 0)
  assertEquals(sumTally([1, 2], NOW), 0)
})

test('recordEmailDeadLetter counts per day, atomically, and drops days past the window', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('dead-letter tally DB tests')
    return
  }
  const db = createDenoDb()
  const clear = () => db.delete(setting).where(eq(setting.key, EMAIL_DEAD_LETTER_TALLY_KEY))
  await clear()
  try {
    await recordEmailDeadLetter(db, NOW - 6 * DAY)
    await Promise.all([recordEmailDeadLetter(db, NOW), recordEmailDeadLetter(db, NOW)])
    await recordEmailDeadLetter(db, NOW - DAY)
    assertEquals(await countEmailDeadLetters(db, NOW), 3)
    const [row] = await db
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, EMAIL_DEAD_LETTER_TALLY_KEY))
    // The six-day-old count was dropped by a later write.
    assertEquals(row?.value, { '2026-11-03': 1, '2026-11-04': 2 })
  } finally {
    await clear()
  }
})
