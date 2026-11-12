/**
 * Keeping notifications honest after the world changes: copies that must not
 * go out any more, a member who left, and history past its retention.
 *
 * - `dropUndeliverableCopies` runs before every retry and digest sweep. A copy
 *   whose event names a project, environment, service, server or backup target
 *   that no longer exists is abandoned with reason `scope_deleted` (no mail
 *   after a delete); a personal copy is abandoned with `no_access` when the
 *   person no longer belongs to the organization, no longer holds the role
 *   the topic's audience asks for (a manager made a plain member, a former
 *   administrator), or their account is disabled.
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
import { eventAudience, NOTIFICATION_EVENTS } from './events.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
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

/** True in SQL when `who` is an install administrator. */
function isAdministrator(who: SQL) {
  return sql`EXISTS (
      SELECT 1 FROM "user" u WHERE u.id = ${who} AND u.role IN ('admin', 'superadmin')
    )`
}

/**
 * True in SQL when `who` may hear a managers-only topic of `org` now: they
 * hold own or manage on it (directly, through a team they are in, or because
 * the organization itself holds it), or they are an administrator hearing
 * every organization. The same people `organizationManagerHolderIds` and the
 * fan-out name; membership itself is `stillBelongs`.
 */
function stillManages(who: SQL, org: SQL) {
  return sql`(EXISTS (
      SELECT 1 FROM permission g
      WHERE g.entity_type = 'organization' AND g.entity_id = ${org}
        AND g.permission IN ('organization:own', 'organization:manage')
        AND (
          (g.actor_type = 'user' AND g.actor_id = ${who})
          OR g.actor_type = 'organization'
          OR (g.actor_type = 'team' AND EXISTS (
            SELECT 1 FROM teammate gm WHERE gm.team_id = g.actor_id AND gm.user_id = ${who}
          ))
        )
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
  // The audience is checked again at send time: a role or an account can
  // change between the event and a held or retried copy. The topic's audience
  // is read from the catalog by the copy's own event code; an install event
  // (no organization) is for administrators whatever the row says.
  const who = sql`a.user_id`
  const org = sql`a.organization_id`
  const codesFor = (audience: string) =>
    JSON.stringify(NOTIFICATION_EVENTS.filter((event) => eventAudience(event) === audience))
  const drop = (condition: SQL) =>
    db.execute(sql`
      UPDATE ${notificationDelivery} a
      SET status = 'abandoned', reason = 'no_access', next_attempt_at = NULL, updated_at = now()
      WHERE a.status IN ${OPEN_STATUSES} AND a.user_id IS NOT NULL AND ${condition}
    `)
  const disabled = await drop(
    sql`EXISTS (SELECT 1 FROM "user" u WHERE u.id = ${who} AND u.is_disabled)`
  )
  const installOnly = await drop(sql`a.organization_id IS NULL AND NOT ${isAdministrator(who)}`)
  const adminsOnly = await drop(
    sql`a.topic_code IN (SELECT jsonb_array_elements_text(${codesFor('admins')}::jsonb))
      AND NOT ${isAdministrator(who)}`
  )
  const managersOnly = await drop(
    sql`a.organization_id IS NOT NULL
      AND a.topic_code IN (SELECT jsonb_array_elements_text(${codesFor('managers')}::jsonb))
      AND NOT ${stillManages(who, org)}`
  )
  const lostRole = [disabled, installOnly, adminsOnly, managersOnly].reduce(
    (total, result) => total + rowCount(result),
    0
  )
  return { scopeDeleted: rowCount(gone), noAccess: rowCount(left) + lostRole }
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
const NOTHING_PRUNED = { inbox: 0, events: 0, ledger: 0, preferences: 0 }

/** The maintenance phase: never throws, like every notification phase (a failed prune waits for the next tick). */
export async function pruneNotificationHistory(
  db: Db,
  opts: { batch?: number } = {}
): Promise<{ inbox: number; events: number; ledger: number; preferences: number }> {
  try {
    return await pruneOnce(db, opts.batch ?? PRUNE_BATCH)
  } catch (error) {
    compatLogWarn(
      'notifications',
      `history prune failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return NOTHING_PRUNED
  }
}

async function pruneOnce(
  db: Db,
  batch: number
): Promise<{ inbox: number; events: number; ledger: number; preferences: number }> {
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
  // Finished copies past the same window, whichever batch of events they belong to.
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
