import { assert, assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import type { EmailJob } from '../email/types.ts'
import { AUDIT_EVENTS, type AuditNotifyEnv } from './audit-bridge.ts'
import {
  describeEvent,
  eventAudience,
  eventIsUrgent,
  eventScope,
  eventSeverity,
  isNotificationEvent,
} from './events.ts'
import { recordKeyEvent } from './key-event.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

test('the next key event is an urgent warning for instance administrators', () => {
  assertEquals(eventScope('panel.identity_next_changed'), 'instance')
  assertEquals(eventSeverity('panel.identity_next_changed'), 'warning')
  assertEquals(eventAudience('panel.identity_next_changed'), 'managers')
  assertEquals(eventIsUrgent('panel.identity_next_changed'), true)
  assertEquals(
    describeEvent('panel.identity_next_changed', { cleared: true }).title,
    'The control plane next key was cleared'
  )
  const set = describeEvent('panel.identity_next_changed', {
    actorEmail: 'root@example.com',
    fingerprint: 'AAAA',
  })
  assertEquals(set.title, 'The control plane next key was changed')
  assert(set.body?.includes('root@example.com set the next key (AAAA)'))
})

test('the pin mismatch event is critical, belongs to an organization, and names both keys', () => {
  assertEquals(eventScope('panel.pin_mismatch'), 'organization')
  assertEquals(eventSeverity('panel.pin_mismatch'), 'critical')
  assertEquals(eventIsUrgent('panel.pin_mismatch'), true)
  const { title, body } = describeEvent('panel.pin_mismatch', {
    serverName: 'web-1',
    reported: 'BBBB',
    expected: 'AAAA',
  })
  assertEquals(title, 'Server web-1 reported a different control plane key')
  assert(body?.includes('holds BBBB') && body.includes('signs with AAAA'))
  assertEquals(describeEvent('panel.pin_mismatch').title.includes('unknown'), true)
})

test('the bridge maps the key audit actions to catalogued events', () => {
  assertEquals(AUDIT_EVENTS['panel.identity_next.set'], 'panel.identity_next_changed')
  assertEquals(AUDIT_EVENTS['panel.identity_next.clear'], 'panel.identity_next_changed')
  assertEquals(AUDIT_EVENTS['server.panel_pin.mismatch'], 'panel.pin_mismatch')
  for (const event of Object.values(AUDIT_EVENTS)) assert(isNotificationEvent(event))
})

type Inserted = Record<string, unknown>

/** A database that records audit inserts and answers every read with the superadmin list. */
function fakeDb(inserted: Inserted[]): Db {
  const chain: Record<string, unknown> = {}
  const rows = [{ email: 'root@example.com' }, { email: 'second@example.com' }]
  chain.from = () => chain
  chain.where = () => chain
  chain.innerJoin = () => chain
  chain.limit = () => chain
  chain.then = (resolve: (value: unknown) => unknown) => resolve(rows)
  return {
    insert: () => ({
      values: (row: Inserted) => {
        inserted.push(row)
        return Object.assign(Promise.resolve([]), {
          returning: () => Promise.resolve([{ id: 'row-1' }]),
        })
      },
    }),
    select: () => chain,
  } as unknown as Db
}

function fakeContext(db: Db, jobs: EmailJob[]): Context<AuditNotifyEnv> {
  const values: Record<string, unknown> = {
    db,
    emailFrom: 'noreply@example.com',
    emailQueue: {
      enqueue: (job: EmailJob) => {
        jobs.push(job)
        return Promise.resolve()
      },
    },
  }
  return { get: (key: string) => values[key] } as unknown as Context<AuditNotifyEnv>
}

test('a key event writes the audit row and mails every superadmin', async () => {
  const inserted: Inserted[] = []
  const jobs: EmailJob[] = []
  await recordKeyEvent(fakeContext(fakeDb(inserted), jobs), {
    organizationId: null,
    actorEmail: 'root@example.com',
    action: 'panel.identity_next.set',
    targetType: 'instance',
    context: { fingerprint: 'AAAA' },
  })
  const audit = inserted.find((row) => row.action === 'panel.identity_next.set')
  assertEquals(audit?.organizationId, null)
  const mails = jobs.filter((job) => job.type === 'notification' && job.event.startsWith('panel.'))
  assertEquals(mails.map((job) => job.to).sort(), ['root@example.com', 'second@example.com'])
  const first = mails[0]
  assert(first.type === 'notification')
  assertEquals(first.title, 'The control plane next key was changed')
  assertEquals(first.severity, 'warning')
})

test('an action with no mapped event is audited and mails nobody', async () => {
  const inserted: Inserted[] = []
  const jobs: EmailJob[] = []
  await recordKeyEvent(fakeContext(fakeDb(inserted), jobs), {
    organizationId: null,
    action: 'instance.tunnel_token.set',
    targetType: 'instance',
  })
  assertEquals(inserted.length, 1)
  assertEquals(jobs.length, 0)
})
