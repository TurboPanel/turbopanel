import { assertEquals } from 'jsr:@std/assert'
import { getTableColumns } from 'drizzle-orm'
import { pgTable } from 'drizzle-orm/pg-core'
import { cidr, inet } from './net-types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('inet and cidr custom types map to native Postgres column types', () => {
  const probe = pgTable('net_type_probe', {
    address: inet('address'),
    network: cidr('network'),
  })
  const columns = getTableColumns(probe)
  assertEquals(columns.address.getSQLType(), 'inet')
  assertEquals(columns.network.getSQLType(), 'cidr')
})
