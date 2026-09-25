import { assertEquals, assertThrows } from '@std/assert'
import {
  getLoadServerStatusRecords,
  setLoadServerStatusRecords,
} from './load-server-status.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('getLoadServerStatusRecords requires a registered loader', () => {
  setLoadServerStatusRecords(null)
  assertThrows(
    () => getLoadServerStatusRecords(),
    Error,
    'loadServerStatusRecords port is not registered',
  )
})

test('setLoadServerStatusRecords wires the loader through', async () => {
  setLoadServerStatusRecords(async (_db, _registry, serverIds) =>
    serverIds.map((serverId) => ({ serverId, connected: true }))
  )
  const loader = getLoadServerStatusRecords()
  const rows = await loader({} as never, null, ['srv-a', 'srv-b'])
  assertEquals(rows, [
    { serverId: 'srv-a', connected: true },
    { serverId: 'srv-b', connected: true },
  ])
  setLoadServerStatusRecords(null)
})
