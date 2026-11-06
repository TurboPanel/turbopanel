/**
 * Development host actions: Update and Restart, and Restart Only.
 *
 * The control plane cannot restart itself mid-request, so it asks the
 * co-located daemon (`dev-host-action`, feature `dev-host-v1`) to run the job
 * and answers as soon as the daemon accepted it. Progress then rides the
 * daemon's `dev-host-status` (`job`), read back through
 * `GET /instance/updates/development` (`host`).
 *
 * - `POST /instance/updates/development/host/update` and `.../host/restart`
 *   on the admin router, superadmin only (`rootOnly`).
 * - The same two actions plus `GET .../dev-host/status` under
 *   `/api/developer/v1/dev-host/*`, behind the developer access middleware,
 *   for the Developer Console.
 *
 * Answers: 202 `{ ok: true, job: { id, action } }`; 409 `job_running` while a
 * host job or the Build and Push Daemon job runs; 503 `daemon_unavailable`
 * when the co-located daemon is offline, lacks `dev-host-v1`, refuses
 * (`reason: 'not_development'`) or does not answer within 8 s.
 *
 * Mounted only from `src/deno-dev.ts`, only while the developer surface is
 * on. No request value reaches the daemon except the fixed action name.
 */
import type { Context, Env, Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { DEVELOPER_API_PREFIX } from '../app/surfaces.ts'
import { createDeveloperAccessMiddleware } from '../client/authn/middleware.ts'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import {
  type DaemonOutboundEnvelope,
  type DevHostAction,
  generateDeliveryId,
  generateRequestId,
} from '../contracts/cell-protocol.ts'
import { type Db, getDaemonCellRegistry, getDb } from '../db/connection.ts'
import { recordAudit } from '../features/audit/audit-records.ts'
import { getServerDaemonStateByServerId } from '../features/servers/server-identity-db.ts'
import type { DerivedSecretsConfig } from '../lib/secrets/secrets.ts'
import { logWarn } from '../lib/logger.ts'
import { DEV_HOST_FEATURE } from '../lib/version-wire.ts'
import { type DevHostStatusStore, devHostStatusStore } from './dev-host-status.ts'
import {
  captureRunningInstanceCommit,
  type DevHostViewDeps,
  isCellConnected,
  readDevHostView,
} from './dev-host-view.ts'
import { isDevelopmentPushJobActive, JOB_RUNNING_ERROR } from './development-updates-routes.ts'

const LOG_COMPONENT = 'development-host'

/** How long a host action waits for the daemon to accept it. */
export const DEV_HOST_ACTION_TIMEOUT_MS = 8_000

export const DAEMON_UNAVAILABLE_ERROR = 'daemon_unavailable'

const AUDIT_ACTIONS = {
  update: 'upgrade.dev_host_update',
  restart: 'upgrade.dev_host_restart',
} as const

export type DevHostRoutesHooks = DevHostViewDeps & {
  pushJobActive?: () => boolean
  daemonFeatures?: (db: Db, serverId: string) => Promise<readonly string[]>
}

type Resolved = {
  store: DevHostStatusStore
  pushJobActive: () => boolean
  daemonFeatures: (db: Db, serverId: string) => Promise<readonly string[]>
  isConnected: (registry: DaemonCellRegistry, serverId: string) => Promise<boolean>
}

function resolveHooks(hooks: DevHostRoutesHooks): Resolved {
  return {
    store: hooks.store ?? devHostStatusStore,
    pushJobActive: hooks.pushJobActive ?? isDevelopmentPushJobActive,
    daemonFeatures:
      hooks.daemonFeatures ??
      (async (db, serverId) => {
        const state = await getServerDaemonStateByServerId(db, serverId)
        return state?.projection?.features ?? []
      }),
    isConnected: hooks.isConnected ?? isCellConnected,
  }
}

export type DevHostActionOutcome =
  | { status: 202; body: { ok: true; job: { id: string; action: DevHostAction } } }
  | { status: 409; body: { ok: false; error: typeof JOB_RUNNING_ERROR } }
  | { status: 503; body: { ok: false; error: typeof DAEMON_UNAVAILABLE_ERROR; reason?: string } }

function unavailable(reason?: string): DevHostActionOutcome {
  return {
    status: 503,
    body: { ok: false, error: DAEMON_UNAVAILABLE_ERROR, ...(reason ? { reason } : {}) },
  }
}

const JOB_RUNNING: DevHostActionOutcome = {
  status: 409,
  body: { ok: false, error: JOB_RUNNING_ERROR },
}

/** Ask the co-located daemon to start `action`; never throws. */
export async function requestDevHostAction(
  db: Db,
  registry: DaemonCellRegistry,
  action: DevHostAction,
  hooks: DevHostRoutesHooks = {}
): Promise<DevHostActionOutcome> {
  const h = resolveHooks(hooks)
  if (h.pushJobActive() || h.store.isJobRunning()) return JOB_RUNNING
  const stored = h.store.get()
  if (!stored) return unavailable()
  const serverId = stored.serverId
  try {
    const [connected, features] = await Promise.all([
      h.isConnected(registry, serverId),
      h.daemonFeatures(db, serverId),
    ])
    if (!connected || !features.includes(DEV_HOST_FEATURE)) return unavailable()
    const envelope: DaemonOutboundEnvelope = {
      kind: 'dev-host-action',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      action,
      at: new Date().toISOString(),
    }
    const record = await registry
      .getCell(serverId)
      .createRequestAndWait(envelope, DEV_HOST_ACTION_TIMEOUT_MS)
    const result = record.result as { ok?: unknown; jobId?: unknown; error?: unknown } | null
    if (record.status === 'done' && result?.ok === true && typeof result.jobId === 'string') {
      h.store.noteJobStarted(result.jobId)
      return { status: 202, body: { ok: true, job: { id: result.jobId, action } } }
    }
    const reason = typeof result?.error === 'string' ? result.error : record.error
    if (reason === JOB_RUNNING_ERROR) return JOB_RUNNING
    return unavailable(record.status === 'expired' ? 'timeout' : reason)
  } catch (err) {
    logWarn(LOG_COMPONENT, `host ${action} request failed: ${String(err)}`)
    return unavailable()
  }
}

function requestDeps(c: Context): { db: Db; registry: DaemonCellRegistry } | Response {
  const db = getDb(c)
  if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
  const registry = getDaemonCellRegistry(c)
  if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
  return { db, registry }
}

function actionHandler(action: DevHostAction, hooks: DevHostRoutesHooks) {
  return async (c: Context) => {
    const ctx = requestDeps(c)
    if (ctx instanceof Response) return ctx
    const outcome = await requestDevHostAction(ctx.db, ctx.registry, action, hooks)
    if (outcome.status === 202) {
      const session = (c as Context<AppEnv>).get('session')
      await recordAudit(ctx.db, {
        organizationId: null,
        actorUserId: session?.userId ?? null,
        actorEmail: session?.email ?? null,
        action: AUDIT_ACTIONS[action],
        targetType: 'instance_updates',
        context: { jobId: outcome.body.job.id },
      })
    }
    return c.json(outcome.body, outcome.status)
  }
}

/**
 * The two admin actions, next to Build and Push Daemon. Call only from the
 * development entry; both are superadmin-only (`rootOnly`). Captures this
 * process's running commit now, before any pull can move the checkout.
 */
export function registerDevHostAdminRoutes(
  admin: Hono<AppEnv>,
  deps: { rootOnly: MiddlewareHandler<AppEnv> },
  hooks: DevHostRoutesHooks = {}
): void {
  void (hooks.runningCommit ?? captureRunningInstanceCommit)()
  admin.post(
    '/instance/updates/development/host/update',
    deps.rootOnly,
    actionHandler('update', hooks)
  )
  admin.post(
    '/instance/updates/development/host/restart',
    deps.rootOnly,
    actionHandler('restart', hooks)
  )
}

/** The Developer Console mounts: status and the two actions. */
export function registerDevHostDeveloperRoutes<E extends Env>(
  app: Hono<E>,
  opts: { secrets: DerivedSecretsConfig; authRequired?: boolean },
  hooks: DevHostRoutesHooks = {}
): void {
  void (hooks.runningCommit ?? captureRunningInstanceCommit)()
  const base = `${DEVELOPER_API_PREFIX}/dev-host`
  if (opts.authRequired !== false) {
    app.use(`${base}/*`, createDeveloperAccessMiddleware(opts.secrets) as MiddlewareHandler)
  }
  app.get(`${base}/status`, async (c) => {
    const ctx = requestDeps(c)
    if (ctx instanceof Response) return ctx
    const host = await readDevHostView(ctx.db, ctx.registry, hooks)
    return c.json({ ok: true, host })
  })
  app.post(`${base}/update`, actionHandler('update', hooks))
  app.post(`${base}/restart`, actionHandler('restart', hooks))
}
