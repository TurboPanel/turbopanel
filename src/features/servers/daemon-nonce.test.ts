import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { nonce } from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { markChallengeUsed, pruneExpiredNonces } from './daemon-nonce.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('a challenge is used once; the prune drops only rows past their window', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('daemon nonce store')
    return
  }
  const db = createDenoDb()
  const tag = crypto.randomUUID()
  const values = [`challenge:${tag}-old`, `challenge:${tag}-live`]
  try {
    const past = new Date('2020-01-01T00:00:00.000Z')
    const future = new Date('2999-01-01T00:00:00.000Z')
    assertEquals(await markChallengeUsed(db, `${tag}-old`, past), true)
    assertEquals(await markChallengeUsed(db, `${tag}-old`, past), false)
    assertEquals(await markChallengeUsed(db, `${tag}-live`, future), true)

    assertEquals((await pruneExpiredNonces(db, new Date('2026-11-02T00:00:00.000Z'))) >= 1, true)
    const left = await db
      .select({ value: nonce.value, kind: nonce.kind })
      .from(nonce)
      .where(inArray(nonce.value, values))
    assertEquals(left, [{ value: `challenge:${tag}-live`, kind: 'challenge' }])
  } finally {
    await db.delete(nonce).where(inArray(nonce.value, values))
    await endDbConnection(db)
  }
})
