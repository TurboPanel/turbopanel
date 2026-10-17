import { assertEquals } from '@std/assert'
import {
  createDbUsage,
  dbUsageLine,
  recordReadModel,
  shouldLogDbUsage,
  withPrimaryStatementCount,
} from './db-usage.ts'

const test = Deno.test.bind(Deno)

test('primary statements are counted and cacheable ones are told apart', () => {
  const usage = createDbUsage()
  const sent: string[] = []
  const client = withPrimaryStatementCount(
    {
      unsafe: (q: string) => {
        sent.push(q)
        return 'ok'
      },
      other: 1,
    },
    usage
  )
  client.unsafe('select "id" from "t" where "id" = $1')
  client.unsafe('select now()')
  client.unsafe('update "t" set "a" = $1')
  assertEquals(client.other, 1)
  assertEquals(sent.length, 3)
  assertEquals(usage.primary, 3)
  assertEquals(usage.primaryCacheable, 1)
  usage.rerunning = true
  client.unsafe('select "id" from "t"')
  assertEquals(usage.primary, 4)
  assertEquals(usage.primaryCacheable, 1)
})

test('the log line names the route, outcomes and counts', () => {
  const usage = createDbUsage()
  assertEquals(dbUsageLine('/servers', usage), null)
  usage.primary = 3
  usage.cached = 1
  recordReadModel(usage, 'servers-list', 'cached')
  recordReadModel(usage, 'server-detail', 'fallback')
  assertEquals(dbUsageLine('/servers', usage), {
    route: '/servers',
    readModel: 'servers-list:cached,server-detail:fallback',
    cached: 1,
    primary: 3,
    primaryCacheable: 0,
    fallback: 1,
  })
})

test('cached routes and fallbacks are always logged, others one in twenty', () => {
  const quiet = createDbUsage()
  quiet.primary = 2
  assertEquals(
    shouldLogDbUsage(quiet, () => 0.5),
    false
  )
  assertEquals(
    shouldLogDbUsage(quiet, () => 0.01),
    true
  )
  const cached = createDbUsage()
  cached.cached = 1
  assertEquals(
    shouldLogDbUsage(cached, () => 0.99),
    true
  )
})
