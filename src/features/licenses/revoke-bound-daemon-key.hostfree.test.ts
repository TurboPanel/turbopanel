import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  revokeBoundDaemonKey,
  setRevokeBoundDaemonKey,
} from './revoke-bound-daemon-key.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('revokeBoundDaemonKey is a no-op until a composition root registers it', async () => {
  setRevokeBoundDaemonKey(null)
  const db = {} as Db
  await revokeBoundDaemonKey(db, 'server-1')
})

test('revokeBoundDaemonKey delegates to the registered function', async () => {
  const seen: string[] = []
  setRevokeBoundDaemonKey(async (_db, serverId) => {
    seen.push(serverId)
  })
  const db = {} as Db
  await revokeBoundDaemonKey(db, 'server-2')
  assertEquals(seen, ['server-2'])
  setRevokeBoundDaemonKey(null)
})
