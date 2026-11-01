/**
 * Shared bits of the self-hosted ingress routes: the per-request service
 * dependencies (read from the Hono context like every admin route) and the
 * audit write for an instance-wide action.
 */
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../../app/app.ts'
import { getDaemonCellRegistry, getDb, type Db } from '../../../db/connection.ts'
import { recordAudit, type AuditAction } from '../../../features/audit/audit-records.ts'
import type { IngressServiceDeps } from './service.ts'

export type IngressAdminDeps = {
  rootOnly: MiddlewareHandler<AppEnv>
  /** This control plane's signing fingerprint; the edge self-check compares against it. */
  selfKid?: () => string | null
  /** Host environment, for `TURBOPANEL_EDGE_GATE`. */
  getEnv?: () => Record<string, string | undefined>
  fetch?: typeof fetch
}

export type RouteServices = { db: Db; service: IngressServiceDeps }

/** The database and service deps for this request, or the 503 to answer. */
export function routeServices(
  c: Context<AppEnv>,
  deps: IngressAdminDeps
): RouteServices | Response {
  const db = getDb(c)
  const registry = getDaemonCellRegistry(c)
  const dataEncryption = c.get('dataEncryptionSecrets')
  if (!db || !registry || !dataEncryption) {
    return c.json({ ok: false, error: 'The control plane is not ready yet.' }, 503)
  }
  return {
    db,
    service: {
      dataEncryption,
      secretsConfig: c.get('secretsConfig'),
      registry,
      env: deps.getEnv?.() ?? {},
      selfKid: deps.selfKid ?? (() => null),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    },
  }
}

export async function auditInstance(
  c: Context<AppEnv>,
  db: Db,
  action: AuditAction,
  targetId: string | null,
  context: Record<string, unknown> | null = null
): Promise<void> {
  const session = c.get('session')
  await recordAudit(db, {
    organizationId: null,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action,
    targetType: 'instance',
    targetId,
    context,
  })
}

export function notFound(c: Context<AppEnv>): Response {
  return c.json({ ok: false, error: 'Hostname not found' }, 404)
}
