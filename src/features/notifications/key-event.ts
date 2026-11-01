/**
 * Control plane key events: audit row, notification, and one direct email to
 * every superadmin.
 *
 * The notification reaches administrators' inboxes and any email channel a
 * rule routes it to. Key events also mail superadmins directly, so the news
 * does not depend on someone having set up a rule first. Mail failures are
 * logged and swallowed, like every other emitter.
 */
import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { user } from '../../db/schema.ts'
import { logWarn } from '../../lib/logger.ts'
import type { AuditEntry } from '../audit/audit-records.ts'
import { getEmailQueue, type EmailQueue } from '../email/types.ts'
import {
  AUDIT_EVENTS,
  type AuditNotifyEnv,
  contextFor,
  recordAuditAndNotify,
} from './audit-bridge.ts'
import { describeEvent, eventSeverity, type NotificationContext } from './events.ts'

async function mailSuperadmins(
  db: Db,
  queue: EmailQueue,
  from: string,
  entry: AuditEntry,
  context: NotificationContext
): Promise<void> {
  const event = AUDIT_EVENTS[entry.action]
  if (!event) return
  try {
    const rows = await db
      .select({ email: user.email })
      .from(user)
      .where(and(eq(user.role, 'superadmin'), eq(user.isDisabled, false)))
    const { title, body } = describeEvent(event, context)
    const at = new Date().toISOString()
    const details = Object.entries(context)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${value}`)
    for (const row of rows) {
      await queue.enqueue({
        type: 'notification',
        to: row.email,
        from,
        event,
        severity: eventSeverity(event),
        title,
        body,
        details,
        organizationName: null,
        consoleUrl: null,
        at,
      })
    }
  } catch (error) {
    logWarn(
      'notifications',
      `key event mail to superadmins failed: ${error instanceof Error ? error.name : 'unknown'}`
    )
  }
}

/** Audit the key event, notify administrators, and email the superadmins. */
export async function recordKeyEvent(
  c: Context<AuditNotifyEnv>,
  entry: AuditEntry,
  extra: NotificationContext = {}
): Promise<void> {
  await recordAuditAndNotify(c, entry, extra)
  const db = c.get('db')
  const queue = getEmailQueue(c)
  if (!db || !queue) return
  const context = contextFor(entry, extra)
  await mailSuperadmins(db, queue, c.get('emailFrom') || 'noreply@turbopanel.local', entry, context)
}
