/**
 * Development-only Admin > Updates routes: Build and Push Daemon.
 *
 * A co-located development install never checks for updates and never starts
 * one on its own. Instead a superadmin builds the daemon from the local
 * checkout (the dev update overlay, `deno task release:dev`) and pushes the
 * `update` command to the connected remote servers.
 *
 * - `GET /instance/updates/development`: the last build, whether the checkout
 *   changed since, the remote servers and whether each runs that build, and
 *   the current or last push job.
 * - `POST /instance/updates/development/push` (`{ force?: boolean }`): starts
 *   one background job (409 `job_running` while one is active) that rebuilds
 *   when the checkout changed, nothing was built, or `force` is set, then
 *   pushes to every connected remote server in parallel.
 *
 * Mounted only from `src/deno-dev.ts` through the `registerDevelopmentAdminRoutes`
 * hook of `startDenoServer`, and only while the developer surface is on; the
 * routes are absent (404) everywhere else. Job state lives in this process
 * (one Deno dev process; a restart forgets it). No request value reaches a
 * shell: the body carries only the `force` boolean.
 */
import { asc } from 'drizzle-orm'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import type { DaemonCellRegistry } from '../contracts/cell.ts'
import { type Db, getDaemonCellRegistry, getDb } from '../db/connection.ts'
import { server } from '../db/schema.ts'
import { recordAudit } from '../features/audit/audit-records.ts'
import { logWarn } from '../lib/logger.ts'
import { type DaemonUpdateResult, fanOutDaemonUpdate } from './daemon-update-fanout.ts'
import {
  DevOverlayRebuildError,
  type DevOverlayState,
  ensureDevOverlayCurrent,
  readDevOverlayState,
} from './dev-update-overlay.ts'

const LOG_COMPONENT = 'development-updates'

/** A development box has a handful of servers; never read more than this. */
export const DEVELOPMENT_SERVER_LIMIT = 200

export const JOB_RUNNING_ERROR = 'job_running'

export type DevelopmentServer = {
  id: string
  name: string | null
  connected: boolean
  daemonVersion: string | null
  daemonCommit: string | null
}

export type DevelopmentPushJobState = 'building' | 'pushing' | 'done' | 'failed'

export type DevelopmentPushJob = {
  id: string
  state: DevelopmentPushJobState
  startedAt: string
  endedAt: string | null
  message: string | null
  servers: {
    id: string
    name: string | null
    ok: boolean
    skipped: boolean
    error: string | null
  }[]
}

export type DevelopmentUpdatesHooks = {
  readState?: () => Promise<DevOverlayState>
  rebuild?: (force: boolean) => Promise<void>
  listRemoteServers?: (db: Db, registry: DaemonCellRegistry) => Promise<DevelopmentServer[]>
  push?: (
    registry: DaemonCellRegistry,
    db: Db,
    serverIds: readonly string[]
  ) => Promise<DaemonUpdateResult[]>
  now?: () => Date
  newId?: () => string
}

let currentJob: DevelopmentPushJob | null = null

/** Forget the job — for tests only. */
export function resetDevelopmentPushJobForTests(): void {
  currentJob = null
}

function isActive(job: DevelopmentPushJob | null): boolean {
  return job !== null && (job.state === 'building' || job.state === 'pushing')
}

/** True when the checkout or the remote fleet differs from the last build. */
export function computePendingDaemonChanges(input: {
  built: { commit: string } | null
  sourceChanged: boolean
  servers: readonly Pick<DevelopmentServer, 'connected' | 'daemonCommit'>[]
}): boolean {
  const connected = input.servers.filter((s) => s.connected)
  if (connected.length === 0) return false
  if (input.sourceChanged || input.built === null) return true
  const commit = input.built.commit
  return connected.some((s) => s.daemonCommit !== commit)
}

/** Remote (non-co-located) servers with their connection and daemon build. */
export async function listRemoteDevelopmentServers(
  db: Db,
  registry: DaemonCellRegistry
): Promise<DevelopmentServer[]> {
  const [colocated, rows] = await Promise.all([
    resolveColocatedServerId(db, registry),
    db
      .select({ id: server.id, name: server.name })
      .from(server)
      .orderBy(asc(server.name), asc(server.id))
      .limit(DEVELOPMENT_SERVER_LIMIT),
  ])
  const remote = rows.filter((row) => row.id !== colocated)
  const snapshots = await registry.getSnapshots(remote.map((row) => row.id))
  return remote.map((row) => {
    const snapshot = snapshots.get(row.id)
    return {
      id: row.id,
      name: row.name ?? null,
      connected: snapshot?.connected === true,
      daemonVersion: snapshot?.daemonBuild?.version ?? null,
      daemonCommit: snapshot?.daemonBuild?.commit ?? null,
    }
  })
}

function errorMessage(err: unknown): string {
  if (err instanceof DevOverlayRebuildError) {
    return err.tail ? `${err.message}\n${err.tail}` : err.message
  }
  return err instanceof Error ? err.message : String(err)
}

function snapshot(job: DevelopmentPushJob | null): DevelopmentPushJob | null {
  return job ? structuredClone(job) : null
}

type Resolved = Required<DevelopmentUpdatesHooks>

function resolveHooks(hooks: DevelopmentUpdatesHooks): Resolved {
  return {
    readState: hooks.readState ?? (() => readDevOverlayState()),
    rebuild: hooks.rebuild ?? ((force) => ensureDevOverlayCurrent({}, { force })),
    listRemoteServers: hooks.listRemoteServers ?? listRemoteDevelopmentServers,
    push: hooks.push ?? ((registry, db, ids) => fanOutDaemonUpdate(registry, db, ids, {})),
    now: hooks.now ?? (() => new Date()),
    newId: hooks.newId ?? (() => crypto.randomUUID()),
  }
}

function finish(
  job: DevelopmentPushJob,
  h: Resolved,
  state: 'done' | 'failed',
  message: string
): void {
  job.state = state
  job.message = message
  job.endedAt = h.now().toISOString()
}

/** Push to the connected remote servers and record each result on the job. */
async function pushToRemotes(
  job: DevelopmentPushJob,
  h: Resolved,
  db: Db,
  registry: DaemonCellRegistry
): Promise<void> {
  job.state = 'pushing'
  const servers = await h.listRemoteServers(db, registry)
  const names = new Map(servers.map((s) => [s.id, s.name]))
  const targets = servers.filter((s) => s.connected).map((s) => s.id)
  if (targets.length === 0) {
    finish(job, h, 'done', 'No connected remote servers to update.')
    return
  }
  const results = await h.push(registry, db, targets)
  job.servers = results.map((r) => ({
    id: r.serverId,
    name: names.get(r.serverId) ?? null,
    ok: r.ok,
    skipped: r.ok && r.skipped === true,
    error: r.error ?? null,
  }))
  const failed = results.filter((r) => !r.ok).length
  if (failed === 0) {
    finish(job, h, 'done', `Updated ${results.length} of ${results.length} servers.`)
  } else {
    finish(job, h, 'failed', `${failed} of ${results.length} servers failed to update.`)
  }
}

async function runJob(
  job: DevelopmentPushJob,
  h: Resolved,
  input: { db: Db; registry: DaemonCellRegistry; force: boolean; needsBuild: boolean }
): Promise<void> {
  try {
    if (input.needsBuild) {
      await h.rebuild(input.force)
      const after = await h.readState()
      if (!after.built) {
        finish(job, h, 'failed', 'The daemon build finished but wrote no build manifest.')
        return
      }
    }
    await pushToRemotes(job, h, input.db, input.registry)
  } catch (err) {
    logWarn(LOG_COMPONENT, `build and push failed: ${errorMessage(err)}`)
    finish(job, h, 'failed', errorMessage(err))
  }
}

/**
 * Register the development update routes on the admin router. Call only from
 * the development entry; both routes are superadmin-only (`rootOnly`).
 */
export function registerDevelopmentUpdatesAdminRoutes(
  admin: Hono<AppEnv>,
  deps: { rootOnly: MiddlewareHandler<AppEnv> },
  hooks: DevelopmentUpdatesHooks = {}
): void {
  const h = resolveHooks(hooks)

  admin.get('/instance/updates/development', deps.rootOnly, async (c) => {
    const ctx = requestDeps(c)
    if (ctx instanceof Response) return ctx
    let state: DevOverlayState
    try {
      state = await h.readState()
    } catch (err) {
      logWarn(LOG_COMPONENT, `cannot read the daemon checkout: ${errorMessage(err)}`)
      return c.json({ ok: false, error: 'daemon_checkout_unavailable' }, 503)
    }
    const listed = await h.listRemoteServers(ctx.db, ctx.registry)
    const built = state.built
    const servers = listed.map((s) => ({
      ...s,
      onLatestBuild: built !== null && s.daemonCommit === built.commit,
    }))
    return c.json({
      ok: true,
      daemonBuild: {
        built: built
          ? {
              commit: built.commit,
              buildId: built.buildId,
              builtAt: built.builtAt,
              source: built.source ?? null,
            }
          : null,
        sourceFingerprint: state.sourceFingerprint,
        sourceChanged: state.sourceChanged,
      },
      servers,
      job: snapshot(currentJob),
      pendingDaemonChanges: computePendingDaemonChanges({
        built,
        sourceChanged: state.sourceChanged,
        servers: listed,
      }),
    })
  })

  admin.post('/instance/updates/development/push', deps.rootOnly, async (c) => {
    const ctx = requestDeps(c)
    if (ctx instanceof Response) return ctx
    const body = (await c.req.json().catch(() => null)) as { force?: unknown } | null
    const force = body?.force === true
    if (isActive(currentJob)) return c.json({ ok: false, error: JOB_RUNNING_ERROR }, 409)
    // Claimed before any await, so a second press sees the running job.
    const job: DevelopmentPushJob = {
      id: h.newId(),
      state: 'building',
      startedAt: h.now().toISOString(),
      endedAt: null,
      message: null,
      servers: [],
    }
    currentJob = job
    let needsBuild = force
    try {
      const state = await h.readState()
      needsBuild = force || state.sourceChanged || state.built === null
    } catch (err) {
      finish(job, h, 'failed', errorMessage(err))
    }
    const session = c.get('session')
    await recordAudit(ctx.db, {
      organizationId: null,
      actorUserId: session?.userId ?? null,
      actorEmail: session?.email ?? null,
      action: 'upgrade.dev_push',
      targetType: 'instance_updates',
      context: { jobId: job.id, force },
    })
    if (isActive(job)) {
      if (!needsBuild) job.state = 'pushing'
      void runJob(job, h, { db: ctx.db, registry: ctx.registry, force, needsBuild })
    }
    return c.json({ ok: true, job: snapshot(job) }, 202)
  })
}

function requestDeps(c: Context<AppEnv>): { db: Db; registry: DaemonCellRegistry } | Response {
  const db = getDb(c)
  if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
  const registry = getDaemonCellRegistry(c)
  if (!registry) return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
  return { db, registry }
}
