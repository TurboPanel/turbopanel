/**
 * Keeping notifications honest after the world changes: copies that must not
 * go out any more, a member who left, and history past its retention.
 *
 * - `dropUndeliverableCopies` runs before every retry and digest sweep. A copy
 *   whose event names a project, environment, service, server or backup target
 *   that no longer exists is abandoned with reason `scope_deleted` (no mail
 *   after a delete); a personal copy for someone who no longer belongs to the
 *   organization is abandoned with `no_access`.
 * - `forgetMember` runs inside the member-removal transaction: that
 *   organization's preference rows, mark-all-read row, organization email
 *   channels naming the person's address, and pending copies. Nothing in any
 *   other organization is touched.
 * - `pruneNotificationHistory` runs on both maintenance ticks: inbox rows
 *   after 90 days, events (and their copies) and older ledger rows after 30
 *   days, in bounded batches; and preference rows of people who no longer
 *   belong to the organization they name (a team edit or team delete removes
 *   membership without the member-removal route).
 */
import { type SQL, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import {
  notification,
  notificationChannel,
  notificationDelivery,
  notificationEvent,
  notificationPreference,
  notificationWatermark,
} from '../../db/schema.ts'

/** Inbox rows are kept this long (owner decision 2026-11-06). */
export const INBOX_RETENTION_DAYS = 90
/** Events and the delivery ledger are kept this long (owner decision 2026-11-06). */
export const LEDGER_RETENTION_DAYS = 30
/** Rows one prune statement removes; the next tick takes the rest. */
export const PRUNE_BATCH = 1000

const OPEN_STATUSES = sql`('pending', 'failed', 'held')`

function rowCount(result: unknown): number {
  const r = result as { count?: number; length?: number; rowCount?: number }
  return r.count ?? r.rowCount ?? r.length ?? 0
}

/** True in SQL when `org` still has `who` as a member, or `who` is an administrator hearing every organization. */
function stillBelongs(who: SQL, org: SQL) {
  return sql`(EXISTS (
      SELECT 1 FROM teammate tm JOIN team t ON t.id = tm.team_id
      WHERE tm.user_id = ${who} AND t.organization_id = ${org}
    ) OR EXISTS (
      SELECT 1 FROM "user" u WHERE u.id = ${who}
        AND u.role IN ('admin', 'superadmin') AND u.is_all_organizations_notified
    ))`
}

export async function dropUndeliverableCopies(
  db: Db
): Promise<{ scopeDeleted: number; noAccess: number }> {
  const gone = await db.execute(sql`
    UPDATE ${notificationDelivery} a
    SET status = 'abandoned', reason = 'scope_deleted', next_attempt_at = NULL, updated_at = now()
    FROM ${notificationEvent} e
    WHERE a.event_id = e.id AND a.status IN ${OPEN_STATUSES} AND (
      (e.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = e.project_id))
      OR (e.environment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM environment v WHERE v.id = e.environment_id))
      OR (e.service_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service s WHERE s.id = e.service_id))
      OR (e.server_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM server h WHERE h.id = e.server_id))
      OR (e.destination_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM destination d WHERE d.id = e.destination_id))
    )
  `)
  const left = await db.execute(sql`
    UPDATE ${notificationDelivery} a
    SET status = 'abandoned', reason = 'no_access', next_attempt_at = NULL, updated_at = now()
    WHERE a.status IN ${OPEN_STATUSES} AND a.user_id IS NOT NULL AND a.organization_id IS NOT NULL
      AND NOT ${stillBelongs(sql`a.user_id`, sql`a.organization_id`)}
  `)
  return { scopeDeleted: rowCount(gone), noAccess: rowCount(left) }
}

/**
 * Everything notification-shaped a person leaves behind in one organization.
 * Call inside the transaction that removes their teammate rows; `email` is
 * their account address (organization email channels may name it).
 */
export async function forgetMember(
  db: Db,
  organizationId: string,
  userId: string,
  email: string | null
): Promise<void> {
  await db.execute(sql`
    DELETE FROM ${notificationPreference}
    WHERE user_id = ${userId}::uuid AND organization_id = ${organizationId}::uuid
  `)
  await db.execute(sql`
    DELETE FROM ${notificationWatermark}
    WHERE user_id = ${userId}::uuid AND organization_id = ${organizationId}::uuid
  `)
  if (email) {
    await db.execute(sql`
      DELETE FROM ${notificationChannel}
      WHERE scope = 'organization' AND organization_id = ${organizationId}::uuid
        AND kind = 'email' AND lower(address) = lower(${email})
    `)
  }
  await db.execute(sql`
    UPDATE ${notificationDelivery}
    SET status = 'abandoned', reason = 'no_access', next_attempt_at = NULL, updated_at = now()
    WHERE user_id = ${userId}::uuid AND organization_id = ${organizationId}::uuid
      AND status IN ${OPEN_STATUSES}
  `)
}

/** One bounded pass of every retention rule. Returns rows removed per table. */
export async function pruneNotificationHistory(
  db: Db,
  opts: { batch?: number } = {}
): Promise<{ inbox: number; events: number; ledger: number; preferences: number }> {
  const batch = opts.batch ?? PRUNE_BATCH
  const inbox = await db.execute(sql`
    DELETE FROM ${notification} WHERE id IN (
      SELECT id FROM ${notification}
      WHERE created_at < now() - make_interval(days => ${INBOX_RETENTION_DAYS})
      ORDER BY created_at LIMIT ${batch}
    )
  `)
  // Deleting an event deletes its copies (attempt.event_id cascades).
  const events = await db.execute(sql`
    DELETE FROM ${notificationEvent} WHERE id IN (
      SELECT id FROM ${notificationEvent}
      WHERE created_at < now() - make_interval(days => ${LEDGER_RETENTION_DAYS})
      ORDER BY created_at LIMIT ${batch}
    )
  `)
  // Ledger rows written before the event table (no event_id), past the same window.
  const ledger = await db.execute(sql`
    DELETE FROM ${notificationDelivery} WHERE id IN (
      SELECT id FROM ${notificationDelivery}
      WHERE created_at < now() - make_interval(days => ${LEDGER_RETENTION_DAYS})
        AND status NOT IN ('pending', 'held')
      ORDER BY created_at LIMIT ${batch}
    )
  `)
  const preferences = await db.execute(sql`
    DELETE FROM ${notificationPreference} WHERE id IN (
      SELECT p.id FROM ${notificationPreference} p
      WHERE p.organization_id IS NOT NULL
        AND NOT ${stillBelongs(sql`p.user_id`, sql`p.organization_id`)}
      LIMIT ${batch}
    )
  `)
  return {
    inbox: rowCount(inbox),
    events: rowCount(events),
    ledger: rowCount(ledger),
    preferences: rowCount(preferences),
  }
}
