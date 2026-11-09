/**
 * The pure half of the fan-out sweep (`finishInterruptedFanOuts`): an event
 * row read back from the database becomes the same input the emit had, and
 * the catalog sync only deprecates when asked. The database half is in
 * `preferences.test.ts`.
 */
import { assertEquals } from '@std/assert'
import { FAN_OUT_SWEEP_GRACE_MS, storedEventFromRow } from './emit.ts'
import { INLINE_ATTEMPT_GRACE_MS } from './records.ts'
import { DEPRECATE_TOPICS_SQL, syncNotificationCatalog } from './catalog-sync.ts'
import type { UnfannedEvent } from './fanout-records.ts'

const test = Deno.test.bind(Deno)

const ROW: UnfannedEvent = {
  id: '00000000-0000-7000-8000-000000000001',
  createdAt: '2026-11-09 10:00:00.000+00',
  organizationId: '00000000-0000-7000-8000-000000000002',
  topicCode: 'server.offline',
  scope: {
    projectId: null,
    environmentId: null,
    serviceId: null,
    serverId: '00000000-0000-7000-8000-000000000003',
    destinationId: null,
  },
  actorUserId: null,
  severity: 'critical',
  data: {
    serverName: 'db-1',
    title: 'Server db-1 is offline',
    body: null,
    targetType: 'server',
    targetId: '00000000-0000-7000-8000-000000000003',
  },
}

test('an event row reads back as the event that was raised', () => {
  const stored = storedEventFromRow(ROW)
  assertEquals(stored?.event, 'server.offline')
  assertEquals(stored?.title, 'Server db-1 is offline')
  assertEquals(stored?.body, null)
  assertEquals(stored?.targetType, 'server')
  assertEquals(stored?.targetId, ROW.scope.serverId)
  assertEquals(stored?.context, { serverName: 'db-1' })
  assertEquals(stored?.scopeIds, ROW.scope)
  assertEquals(stored?.at, '2026-11-09T10:00:00.000Z')
})

test('a row without the rendered text is described again from its context', () => {
  const stored = storedEventFromRow({ ...ROW, data: { serverName: 'db-1' } })
  assertEquals(typeof stored?.title, 'string')
  assertEquals(stored!.title.length > 0, true)
  assertEquals(stored?.context, { serverName: 'db-1' })
})

test('a code this build no longer has is not fanned out', () => {
  assertEquals(storedEventFromRow({ ...ROW, topicCode: 'server.vanished' }), null)
})

test('the sweep waits longer than the inline attempt grace, so it never races a live emit', () => {
  assertEquals(FAN_OUT_SWEEP_GRACE_MS > INLINE_ATTEMPT_GRACE_MS, true)
})

test('a running process never deprecates codes; migrate does', async () => {
  const statements: string[] = []
  const run = (text: string) => {
    statements.push(text)
    return Promise.resolve()
  }
  await syncNotificationCatalog(run, { deprecate: false })
  assertEquals(statements.includes(DEPRECATE_TOPICS_SQL), false)
  assertEquals(statements.length, 2)
  await syncNotificationCatalog(run, { deprecate: true })
  assertEquals(statements.at(-1), DEPRECATE_TOPICS_SQL)
})
