/**
 * Host-free coverage for `listUsersReferencingDatabase`, the managed database
 * drop guard. Kept apart from routes-helpers.hostfree.test.ts, which predates
 * the Prettier gate and cannot be touched without a whole-file reflow.
 */

import { assertEquals } from '@std/assert'
import { listUsersReferencingDatabase } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('listUsersReferencingDatabase lists only SQL users that name the database', () => {
  const logins = [
    { username: 'root', role: 'root', databases: ['app'] },
    { username: 'repl', role: 'replication', databases: ['app'] },
    { username: 'alice', role: 'user', databases: ['postgres', 'app'] },
    { username: 'bob', role: 'user', databases: ['postgres'] },
    { username: 'dave', role: 'user', databases: [] },
  ]
  assertEquals(listUsersReferencingDatabase(logins, 'app'), ['alice'])
  assertEquals(listUsersReferencingDatabase(logins, 'postgres'), ['alice', 'bob'])
  assertEquals(listUsersReferencingDatabase(logins, 'gone'), [])
})
