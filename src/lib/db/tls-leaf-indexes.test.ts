/**
 * Guard: tlsleaf partial unique indexes stay in the generated migration.
 */

import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('migrations/0000_init.sql declares tlsleaf partial unique indexes', async () => {
  const here = dirname(fromFileUrl(import.meta.url))
  const sqlPath = join(here, '../../../migrations/0000_init.sql')
  const sql = await Deno.readTextFile(sqlPath)
  assertEquals(sql.includes('CREATE UNIQUE INDEX "uniq_tlsleaf_ingress_server"'), true)
  assertEquals(
    sql.includes('WHERE "tlsleaf"."kind" = \'ingress\''),
    true,
  )
  assertEquals(sql.includes('CREATE UNIQUE INDEX "uniq_tlsleaf_engine_node"'), true)
  assertEquals(
    sql.includes('WHERE "tlsleaf"."kind" = \'engine\''),
    true,
  )
  assertEquals(sql.includes('CREATE INDEX "idx_tlsleaf_not_after"'), true)
  assertEquals(sql.includes('CREATE INDEX "idx_tlsleaf_organization_id"'), true)
})
