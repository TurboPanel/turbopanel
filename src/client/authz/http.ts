import type { Context } from 'hono'
import { getDb } from '../../db.ts'
import { can, type PermissionKey } from './evaluator.ts'
import { resolveWorkspaceKindForEntity } from './workspace-kind-ancestry.ts'
import { WORKSPACE_KIND_TURBOPANEL } from '../../lib/db/workspace-kind.ts'

/** Typed 403 body when a mutation targets a system-workspace descendant. */
export const SYSTEM_RESOURCE_IMMUTABLE_ERROR = 'system_resource_immutable'

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

/**
 * Exact owner-only guard for owner-only routes (access-grant management,
 * license lifecycle). Requires an `organization:own` grant on the entity's
 * organization — an `organization:manage` grant is NOT sufficient. Resolves the
 * entity's owning organization via {@link can}, so it works for any entity type
 * (organization, team, or a resource that resolves to an org).
 *
 * Use this instead of `assertCanOr403(c, 'organization:own', …)` at owner-only
 * call sites so the owner-only intent is explicit and cannot be silently
 * downgraded to a broad org-access check.
 */
export async function assertOrgOwnerOr403(
  c: Context,
  entityType: string,
  entityId: string,
): Promise<Response | null> {
  return assertCanOr403(c, 'organization:own', entityType, entityId)
}

/**
 * Secondary immutability guard for system-owned resource-tree entities.
 *
 * Run **after** the route's normal org-access check so a non-member still gets
 * the usual Forbidden response and never learns that a system resource exists.
 *
 * Returns `null` when the entity has no workspace ancestor (`null` from
 * {@link resolveWorkspaceKindForEntity}) or when `kind === 'user'`. Org-owned
 * registries with no workspace ancestry — `tls`, `network`, `datacenter`,
 * `ip`, `team`, `organization`, `license`, and server-scoped
 * variables — intentionally need no guard; do not "fix" that omission by
 * inventing joins.
 *
 * When `kind === 'turbopanel'`, returns `403` with
 * `{ error: 'system_resource_immutable' }`.
 */
export async function assertNotSystemOwnedOr403(
  c: Context,
  entityType: string,
  entityId: string,
): Promise<Response | null> {
  const db = getDb(c)
  if (!db) {
    return c.json({ error: 'Database unavailable' }, 503)
  }

  const kind = await resolveWorkspaceKindForEntity(db, entityType, entityId)
  if (kind === WORKSPACE_KIND_TURBOPANEL) {
    return c.json({ error: SYSTEM_RESOURCE_IMMUTABLE_ERROR }, 403)
  }

  return null
}
