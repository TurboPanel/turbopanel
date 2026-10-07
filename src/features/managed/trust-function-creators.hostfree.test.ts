/**
 * Host-free coverage: app users can create triggers and stored functions.
 *
 * With the binary log on, MySQL and MariaDB refuse CREATE TRIGGER / CREATE
 * FUNCTION for a user without SUPER (error 1419) unless
 * log_bin_trust_function_creators is on. Row-based logging makes that safe.
 */

import { assertEquals } from '@std/assert'
import { mariadbEngineSpec } from './mariadb.ts'
import { mysqlEngineSpec } from './mysql.ts'

const test = Deno.test.bind(Deno)

for (const spec of [mysqlEngineSpec, mariadbEngineSpec]) {
  test(`${spec.engine} platform my.cnf trusts function creators and logs rows`, () => {
    const settings = spec.parseSettings(spec.defaultSettings)
    if (!settings) throw new TypeError('expected default settings')
    const runtime = spec.buildRuntimeSpec({
      managedId: '11111111-1111-1111-1111-111111111111',
      settings,
      rootUsername: 'root',
    })
    const conf = runtime.configFiles.find((f) => f.path === 'my.cnf')?.contents ?? ''
    assertEquals(conf.includes('log_bin_trust_function_creators=ON'), true)
    assertEquals(conf.includes('binlog_format=ROW'), true)
  })
}
