import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { audit } from '../../db/schema.ts'
import {
  DEAD_LETTER_ALERT_THRESHOLD,
  type DeadLetterRecord,
  recordDeadLetter,
} from './dead-letter-consumer.ts'

/** Jest/Mocha-shaped alias so Sonar sees real tests (see AGENTS.md). */
const test = Deno.test.bind(Deno)

function record(messageId: string): DeadLetterRecord {
  return {
    queue: 'commands',
    messageId,
    type: 'deploy',
    commandId: 'cmd-1',
    serverId: 'srv-1',
    attempts: 3,
    error: 'delivery retries exhausted',
    seenAt: '2026-11-23T10:00:00.000Z',
  }
}

test('recordDeadLetter writes one row per message id and alerts on the first and at the threshold', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('dead-letter record DB tests')
    return
  }
  const db = createDenoDb()
  const clear = () => db.delete(audit).where(eq(audit.action, 'queue.dead_letter'))
  await clear()
  try {
    assertEquals(await recordDeadLetter(db, record('m-0')), { recorded: true, alert: 'first' })
    // Redelivery of the same message: no second row, no second alert.
    assertEquals(await recordDeadLetter(db, record('m-0')), { recorded: false })
    for (let i = 1; i < DEAD_LETTER_ALERT_THRESHOLD - 1; i++) {
      assertEquals(await recordDeadLetter(db, record(`m-${i}`)), { recorded: true, alert: null })
    }
    assertEquals(await recordDeadLetter(db, record('m-last')), {
      recorded: true,
      alert: 'threshold',
    })
    assertEquals(await recordDeadLetter(db, record('m-after')), { recorded: true, alert: null })
    const rows = await db.select().from(audit).where(eq(audit.action, 'queue.dead_letter'))
    assertEquals(rows.length, DEAD_LETTER_ALERT_THRESHOLD + 1)
    assertEquals(rows[0]?.organizationId, null)
    assertEquals(JSON.stringify(rows[0]?.context).includes('secret'), false)
  } finally {
    await clear()
  }
})

test('concurrent deliveries of one message record it once', async () => {
  if (!getDatabaseUrl()) {
    skipWithoutDatabase('dead-letter record DB tests')
    return
  }
  const db = createDenoDb()
  const clear = () => db.delete(audit).where(eq(audit.action, 'queue.dead_letter'))
  await clear()
  try {
    const results = await Promise.all([
      recordDeadLetter(db, record('dup')),
      recordDeadLetter(db, record('dup')),
    ])
    assertEquals(results.filter((r) => r.recorded).length, 1)
  } finally {
    await clear()
  }
})
