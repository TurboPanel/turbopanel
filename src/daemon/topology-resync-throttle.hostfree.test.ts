import { assertEquals } from '@std/assert'
import { topologyChurnLimitedRecently } from '../features/servers/server-topology-records.ts'
import { topologyResyncRecentlyRequested } from './api-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW_MS = Date.parse('2026-10-07T12:00:00.000Z')
const marker = (at: string) => ({ topologyResyncRequestedAt: at })

test('a fresh topology resync marker is not stamped again', () => {
  assertEquals(topologyResyncRecentlyRequested(marker('2026-10-07T11:58:00.000Z'), NOW_MS), true)
})

test('a stale, missing or unreadable topology resync marker is stamped again', () => {
  assertEquals(topologyResyncRecentlyRequested(marker('2026-10-07T11:50:00.000Z'), NOW_MS), false)
  assertEquals(topologyResyncRecentlyRequested({}, NOW_MS), false)
  assertEquals(topologyResyncRecentlyRequested(null, NOW_MS), false)
  assertEquals(topologyResyncRecentlyRequested(marker('not a date'), NOW_MS), false)
})

test('a recent churn-limit alert holds back the resync request so a refused report cannot loop it', () => {
  const stamped = (at: string) => ({ topologyChurnLimitedAt: at })
  assertEquals(topologyChurnLimitedRecently(stamped('2026-10-07T11:30:00.000Z'), NOW_MS), true)
  // An hour on, the window can have freed up: the resync request is allowed again.
  assertEquals(topologyChurnLimitedRecently(stamped('2026-10-07T10:50:00.000Z'), NOW_MS), false)
  assertEquals(topologyChurnLimitedRecently({}, NOW_MS), false)
  assertEquals(topologyChurnLimitedRecently(null, NOW_MS), false)
  assertEquals(topologyChurnLimitedRecently(stamped('nope'), NOW_MS), false)
})
