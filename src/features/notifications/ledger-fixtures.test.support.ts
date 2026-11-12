/**
 * Test support: the keys a hand-written `attempt` row needs. Every delivery
 * copy hangs from an `event` row and names its topic, so a fixture inserts a
 * real event first (one per row: `uniq_attempt_copy` allows one copy of an
 * event per person and channel).
 */
import type { Db } from '../../db/connection.ts'
import { notificationEvent } from '../../db/schema.ts'
import { ensureNotificationCatalog } from './fanout-records.ts'
import type { NotificationEvent, NotificationSeverity } from './events.ts'

export type LedgerKeys = {
  eventId: string
  topicCode: NotificationEvent
  /** The older column the table still requires until the reset removes it. */
  event: NotificationEvent
}

/** `count` event rows for one organization, and the keys that tie a delivery row to each. */
export async function insertLedgerKeys(
  db: Db,
  organizationId: string | null,
  count = 1,
  opts: { topic?: NotificationEvent; severity?: NotificationSeverity } = {}
): Promise<LedgerKeys[]> {
  const topic = opts.topic ?? 'server.offline'
  await ensureNotificationCatalog(db)
  const rows = await db
    .insert(notificationEvent)
    .values(
      Array.from({ length: count }, () => ({
        organizationId,
        topicCode: topic,
        severity: opts.severity ?? 'critical',
      }))
    )
    .returning({ id: notificationEvent.id })
  return rows.map((row) => ({ eventId: row.id, topicCode: topic, event: topic }))
}
