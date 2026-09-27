/**
 * The fake Analytics Engine must refuse exactly what the real AE SQL API
 * refused on testing (2026-09-27), with the same status and wording, and must
 * accept the rewritten forms that AE accepts. The parity tests run every
 * query helper against this fake; if it quietly accepted what AE refuses
 * (DuckDB accepts all of the refused statements below), those tests would
 * pass while production charts showed "Metrics store unavailable".
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { it } from '@std/testing/bdd'
import { AE_DATASET_NAME } from './field-map.ts'
import { AE_SQL_MAX_LENGTH } from './ae-sql-dialect.ts'
import { CloudflareAnalyticsSqlClient } from './sql-api.ts'
import { createFakeAnalyticsEngine } from '../../testing/fake-analytics-engine.ts'

const T = AE_DATASET_NAME

/** Statements the real AE refused, and the text of its live `422`. */
const LIVE_REFUSALS: Array<{ sql: string; live: string }> = [
  {
    sql: `SELECT max(blob7) AS generation FROM ${T}`,
    live: 'cannot use the String type as argument 1 in max(',
  },
  {
    sql: `SELECT count() AS n FROM ${T} WHERE blob10 LIKE CONCAT('eth', '%')`,
    live: 'unknown function call: CONCAT',
  },
  {
    sql: `SELECT sum(if(blob1 = 'x', _sample_interval, 0.0)) AS s FROM ${T}`,
    live: 'the 2nd and 3rd arguments to IF() function must have the same type but instead had Integer and Double',
  },
  {
    sql: `SELECT count() AS n FROM ${T} WHERE blob1 = '${'x'.repeat(AE_SQL_MAX_LENGTH)}'`,
    live: 'SQL was excessively long, exceeded maximum length: 10000',
  },
]

/** The rewritten forms production sends now; AE accepts every one. */
const ACCEPTED: string[] = [
  `SELECT max(toUInt32(blob7)) AS generation FROM ${T}`,
  `SELECT count() AS n FROM ${T} WHERE startsWith(blob10, 'eth')`,
  `SELECT sum(if(blob1 = 'x', _sample_interval * 1.0, 0.0)) AS s FROM ${T}`,
]

for (const { sql, live } of LIVE_REFUSALS) {
  it(`the fake AE refuses like the real one: ${live.slice(0, 48)}`, async () => {
    const fake = await createFakeAnalyticsEngine()
    try {
      const client = new CloudflareAnalyticsSqlClient(fake.sqlConfig)
      const error = await assertRejects(() => client.executeSql(sql, 'fidelity'))
      const message = (error as Error).message
      if (sql.length > AE_SQL_MAX_LENGTH) {
        // executeSql refuses before the round trip, naming the builder.
        assertStringIncludes(message, `exceeds ${AE_SQL_MAX_LENGTH}`)
      } else {
        assertStringIncludes(message, 'AE SQL HTTP 422 (fidelity)')
        assertStringIncludes(message.toLowerCase(), live.toLowerCase().slice(0, 40))
      }
      // The fake's own validator names the refusal in AE's words either way.
      const fakeFetch = fake.sqlConfig.fetch
      assert(fakeFetch, 'the fake AE exposes its fetch')
      const direct = await fakeFetch('https://ae.test/sql', { method: 'POST', body: sql })
      assertEquals(direct.status, 422)
      assertStringIncludes((await direct.text()).toLowerCase(), live.toLowerCase().slice(0, 40))
    } finally {
      await fake.close()
    }
  })
}

it('the fake AE accepts the forms production sends after the fixes', async () => {
  const fake = await createFakeAnalyticsEngine()
  try {
    const client = new CloudflareAnalyticsSqlClient(fake.sqlConfig)
    for (const sql of ACCEPTED) {
      const result = await client.executeSql(sql, 'fidelity')
      assertEquals(Array.isArray(result.data), true, sql)
    }
  } finally {
    await fake.close()
  }
})
