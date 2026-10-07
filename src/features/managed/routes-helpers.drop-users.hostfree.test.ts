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
  const principals = [
    { username: 'root', metadata: { managedRoot: true, databases: ['app'] } },
    {
      username: 'repl',
      metadata: { managedReplication: true, databases: ['app'] },
    },
    { username: 'alice', metadata: { databases: ['postgres', 'app'] } },
    { username: 'bob', metadata: { databases: ['postgres'] } },
    { username: 'carol', metadata: { databases: 'app' } },
    { username: 'dave', metadata: null },
  ]
  assertEquals(listUsersReferencingDatabase(principals, 'app'), ['alice'])
  assertEquals(listUsersReferencingDatabase(principals, 'postgres'), ['alice', 'bob'])
  assertEquals(listUsersReferencingDatabase(principals, 'gone'), [])
})
