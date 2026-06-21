import type { Context } from 'hono'
import { getDb } from '../db.ts'
import { can, type PermissionKey } from './evaluator.ts'

/**
 * Hono guard around {@link can}. Returns a `Response` to short-circuit the
 * handler (503 / 401 / 403) or `null` to continue:
 *
 * ```ts
 * const denied = await assertCanOr403(c, 'server:ro', 'server', serverId)
 * if (denied) return denied
 * ```
 */
export async function assertCanOr403(
  c: Context,
  permissionKey: PermissionKey,
  entityType: string,
  entityId: string,
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) {
    return c.json({ ok: false, error: 'Database unavailable' }, 503)
  }

  const session = c.get('session') as { userId: string; role?: string } | undefined
  if (!session) {
    return c.json({ ok: false, error: 'Unauthorized' }, 401)
  }

  const allowed = await can(db, session.userId, permissionKey, entityType, entityId)
  if (!allowed) {
    return c.json({ ok: false, error: 'Forbidden' }, 403)
  }

  return null
}
