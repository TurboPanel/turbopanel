import { assertEquals } from '@std/assert'
import { buildDigestGroups, buildDigestJob, DIGEST_MAX_GROUPS, DIGEST_MAX_ITEMS } from './digest.ts'
import { eventIsUrgent, NOTIFICATION_EVENTS } from './events.ts'
import type { NotificationDeliveryRecord } from './records.ts'

const test = Deno.test.bind(Deno)

function delivery(event: string, severity: 'info' | 'warning' | 'critical', n: number) {
  return {
    id: `d${n}`,
    channelId: 'c',
    organizationId: 'org',
    event,
    severity,
    status: 'pending',
    attempts: 0,
    payload: {
      event,
      severity,
      title: `${event} ${n}`,
      body: null,
      organizationId: 'org',
      organizationName: null,
      targetType: 'server',
      targetId: `s${n}`,
      context: {},
      at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    },
  } as unknown as NotificationDeliveryRecord
}

test('groups are by event, most severe then most frequent first, capped, with counts kept', () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => delivery('server.deleted', 'info', i)),
    delivery('server.daemon_key_revoked', 'warning', 20),
    delivery('server.daemon_key_revoked', 'warning', 21),
  ]
  const { groups, moreGroups } = buildDigestGroups(rows, 'https://p.example.com')
  assertEquals(
    groups.map((g) => [g.event, g.count, g.items.length]),
    [
      ['server.daemon_key_revoked', 2, 2],
      ['server.deleted', 7, DIGEST_MAX_ITEMS],
    ]
  )
  assertEquals(moreGroups, 0)
  assertEquals(groups[1]?.items[0]?.url, 'https://p.example.com/org/servers/s0')
  // Items run oldest first.
  assertEquals(groups[1]?.items.map((i) => i.title)[0], 'server.deleted 0')
})

test('event kinds past the cap are counted, not listed', () => {
  const rows = Array.from({ length: DIGEST_MAX_GROUPS + 3 }, (_, i) =>
    delivery(`kind.${i}`, 'info', i)
  )
  const { groups, moreGroups } = buildDigestGroups(rows, null)
  assertEquals(groups.length, DIGEST_MAX_GROUPS)
  assertEquals(moreGroups, 3)
})

test('the digest job totals every row and links back to the app', () => {
  const job = buildDigestJob({
    to: 'a@example.com',
    email: {
      queue: { enqueue: () => Promise.resolve() },
      from: 'n@example.com',
      consoleBaseUrl: 'https://p.example.com',
    },
    summary: 'daily',
    deliveries: [delivery('server.deleted', 'info', 1), delivery('server.deleted', 'info', 2)],
    nowMs: Date.UTC(2026, 0, 2),
  })
  assertEquals(job.total, 2)
  assertEquals(job.consoleUrl, 'https://p.example.com')
  assertEquals(job.at, '2026-01-02T00:00:00.000Z')
})

test('urgent events are the outages and the security changes; only routine ones can wait', () => {
  const urgent = NOTIFICATION_EVENTS.filter((e) => eventIsUrgent(e))
  assertEquals(urgent.includes('server.offline'), true)
  assertEquals(urgent.includes('fleet.mass_disconnect'), true)
  assertEquals(urgent.includes('access.grant_revoked'), true)
  assertEquals(urgent.includes('server.daemon_key_revoked'), true)
  assertEquals(eventIsUrgent('server.deleted'), false)
})
