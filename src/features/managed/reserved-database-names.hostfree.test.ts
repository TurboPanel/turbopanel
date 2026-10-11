/**
 * Host-free coverage for the reserved (system schema) database names.
 */

import { assertEquals } from '@std/assert'
import { mariadbEngineSpec } from './mariadb.ts'
import { mysqlEngineSpec } from './mysql.ts'
import { postgresEngineSpec } from './postgres.ts'
import {
  isReservedDatabaseName,
  reservedDatabaseNames,
  validateManagedDatabaseCreateName,
} from './routes-helpers.ts'

const test = Deno.test.bind(Deno)

test('MySQL and MariaDB refuse every system schema name, in any letter case', () => {
  for (const spec of [mysqlEngineSpec, mariadbEngineSpec]) {
    const id = spec.userOperations.identifier
    for (const name of [
      'mysql',
      'MySQL',
      'information_schema',
      'performance_schema',
      'sys',
      'SYS',
    ]) {
      assertEquals(validateManagedDatabaseCreateName(name, ['defaultdb'], id, spec.engine), {
        ok: false,
        error: 'reserved_database_name',
        status: 400,
      })
    }
  }
})

test('MySQL and MariaDB still accept ordinary names that merely contain a system schema name', () => {
  for (const spec of [mysqlEngineSpec, mariadbEngineSpec]) {
    const id = spec.userOperations.identifier
    for (const name of ['app_sys', 'mysql_app', 'sys2', 'myinformation_schema']) {
      assertEquals(validateManagedDatabaseCreateName(name, ['defaultdb'], id, spec.engine), null)
    }
  }
})

test('the reserved list applies to the MySQL family only', () => {
  assertEquals(reservedDatabaseNames('mysql').length, 4)
  assertEquals(reservedDatabaseNames('mariadb').length, 4)
  assertEquals(reservedDatabaseNames(postgresEngineSpec.engine), [])
  assertEquals(isReservedDatabaseName(postgresEngineSpec.engine, 'sys'), false)
  assertEquals(
    validateManagedDatabaseCreateName(
      'sys',
      ['postgres'],
      postgresEngineSpec.userOperations.identifier,
      postgresEngineSpec.engine
    ),
    null
  )
})

test('an engine argument is optional and defaults to no reserved names', () => {
  const id = mysqlEngineSpec.userOperations.identifier
  assertEquals(validateManagedDatabaseCreateName('mysql', ['defaultdb'], id), null)
})
