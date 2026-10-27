import { eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { resolveBuildLabel, resolveInstanceRevision } from '../app/build-info.ts'
import { INSTANCE_VERSION } from '../app/version.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import { resolveInstanceUpdateChannel } from '../contracts/update-channel.ts'
import { type Db, getDaemonCellRegistry, getDb } from '../db/connection.ts'
import { upgrade, user } from '../db/schema.ts'
import { recordAudit } from '../features/audit/audit-records.ts'
import { resolveUpdateManifest } from '../features/update/manifest.ts'
import { isExplicitDevelopmentMode } from '../lib/dev-mode.ts'
import { createUpgradeCoordinator } from '../features/upgrades/coordinator.ts'
import { createDrizzleUpgradeStore } from '../features/upgrades/store.ts'
import { isUuid, parseHistoryQuery, parseRunServersQuery } from '../features/upgrades/history.ts'
import { readHistoryPage, readRunServersPage } from '../features/upgrades/history-read.ts'
import {
  parseUpgradeVerifyTimeoutMs,
  UPGRADE_VERIFY_TIMEOUT_ENV,
} from '../features/upgrades/transitions.ts'
import { uiBehindTarget, updateAvailableFor } from '../features/upgrades/target.ts'
import {
  normalizeUpgradeSettings,
  parseUpgradeBatchDefault,
} from '../features/settings/upgrade-settings.ts'
import {
  ensureUpgradeCheckSchedule,
  getUpgradePause,
  markUpgradeCheckedByHand,
  pauseUpgrades,
  readUpgradeCheckSchedule,
  resumeUpgrades,
  type UpgradePause,
} from '../features/settings/upgrade-control.ts'
import {
  latestUpgradeCheckAt,
  manualCheckWaitSeconds,
  nextUpgradeCheckAt,
} from '../features/upgrades/schedule.ts'
import {
  parseUpgradeCheckMinutes,
  UPGRADE_CHECK_MINUTES_ENV,
} from '../features/upgrades/tick-cadence.ts'
import {
  resolveUpgradeTarget,
  setLatestAvailableBuild,
} from '../features/upgrades/target-resolve.ts'
import { UPGRADE_ACTIVE_STATUSES } from '../features/upgrades/vocabulary.ts'
import type { UpdateManifestTarget } from '../features/update/manifest.ts'
import { resolvePlatformEnv } from './routes-helpers.ts'

const NO_DAEMON_ERROR = 'no co-located daemon connected to update the control plane'

/**
 * Machine code for every retired manual-update route (HTTP 410). Updates are
 * automatic; the only control is Pause all updates in Admin > Updates.
 */
export const UPDATES_AUTOMATIC_ERROR = 'updates_automatic'

/** Check Now pressed again within a minute (HTTP 429). */
export const CHECK_TOO_SOON_ERROR = 'check_too_soon'

export const UPDATES_AUTOMATIC_MESSAGE =
  'Updates are automatic and cannot be started, retried or cancelled by hand. To hold them, use Pause all updates in Admin > Updates.'

/** The routes that used to start, retry or cancel an update by hand. */
const RETIRED_UPDATE_ROUTES = [
  '/instance/updates/instance',
  '/instance/updates/daemon',
  '/instance/updates/preflight',
  '/instance/updates/runs',
  '/instance/updates/steps/:id/retry',
  '/instance/updates/runs/:id/cancel',
] as const

/** The answer every retired manual-update route gives. */
export function updatesAutomaticResponse(c: Context): Response {
  return c.json(
    { ok: false, error: UPDATES_AUTOMATIC_ERROR, message: UPDATES_AUTOMATIC_MESSAGE },
    410
  )
}

type ColocatedDaemon = {
  serverId: string | null
  connected: boolean
  version: string | null
  commit: string | null
  builtAt: string | null
}

async function readColocatedDaemon(c: Context<AppEnv>): Promise<ColocatedDaemon> {
  const empty: ColocatedDaemon = {
    serverId: null,
    connected: false,
    version: null,
    commit: null,
    builtAt: null,
  }
  const db = getDb(c)
  const registry = getDaemonCellRegistry(c)
  if (!db || !registry) return empty
  const serverId = await resolveColocatedServerId(db, registry)
  if (!serverId) return empty
  const snapshots = await registry.getSnapshots([serverId])
  const snapshot = snapshots.get(serverId)
  const build = snapshot?.daemonBuild
  return {
    serverId,
    connected: snapshot?.connected === true,
    version: build?.version ?? null,
    commit: build?.commit ?? null,
    builtAt: build?.builtAt ?? null,
  }
}

/**
 * Installed versions, channel targets, the read-only run and history API, the
 * batch size setting, and Pause / Resume. Updates start on their own (the
 * hourly check); the routes that started, retried or cancelled one by hand
 * answer 410 `updates_automatic`. The control-plane row is `INSTANCE_VERSION`.
 */
export function registerInstanceUpdatesAdminRoutes(
  admin: Hono<AppEnv>,
  opts: {
    runtime: 'deno' | 'workers'
    getEnv?: () => Record<string, string | undefined>
  }
): void {
  admin.get('/instance/updates', async (c) => c.json(await readUpdatesStatus(c, opts)))

  // Check Now: a refresh only. It asks the release servers for the newest
  // build (at most once a minute) and answers the fresh status; it never
  // starts a run and never moves the schedule — the next scheduled check does.
  admin.post('/instance/updates/check', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const now = new Date()
    const schedule = await ensureUpgradeCheckSchedule(db, now.toISOString())
    const wait = manualCheckWaitSeconds(schedule, now)
    if (wait > 0) {
      c.header('Retry-After', String(wait))
      return c.json(
        {
          ok: false,
          error: CHECK_TOO_SOON_ERROR,
          retryAfterSeconds: wait,
          message: `Checked a moment ago. Try again in ${wait} seconds.`,
        },
        429
      )
    }
    await markUpgradeCheckedByHand(db, schedule, now.toISOString())
    const channel = resolveInstanceUpdateChannel(resolvePlatformEnv(c, opts))
    const target = await resolveUpgradeTarget(channel, (kind) =>
      resolveUpdateManifest(channel, kind, { fresh: true })
    )
    await setLatestAvailableBuild(db, target)
    return c.json(await readUpdatesStatus(c, opts))
  })

  for (const path of RETIRED_UPDATE_ROUTES) {
    admin.post(path, (c) => updatesAutomaticResponse(c))
  }

  admin.post('/instance/updates/pause', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const session = c.get('session')
    const requested: UpgradePause = {
      since: new Date().toISOString(),
      byUserId: session?.userId ?? null,
      byEmail: session?.email ?? null,
      byName: session?.userId ? await readUserName(db, session.userId) : null,
    }
    const { pause, changed } = await pauseUpgrades(db, requested)
    if (changed) await auditPause(c, db, 'upgrade.pause', { since: pause.since })
    return c.json({ ok: true, ...pauseFields(pause) })
  })

  admin.post('/instance/updates/resume', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const prior = await getUpgradePause(db)
    if (await resumeUpgrades(db)) {
      await auditPause(c, db, 'upgrade.resume', { pausedSince: prior?.since ?? null })
    }
    return c.json({ ok: true, ...pauseFields(null) })
  })

  admin.get('/instance/updates/run', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    const run = await coordinator.activeRun()
    // A failed run is no longer active; keep the last one (and why it ended)
    // on the progress panel instead of silently dropping back to "available".
    const lastRun = run ? null : await coordinator.lastRun()
    return c.json({ ok: true, run, lastRun })
  })

  admin.get('/instance/updates/runs/:id', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    const run = await coordinator.run(c.req.param('id'))
    if (!run) return c.json({ ok: false, error: 'upgrade_run_not_found' }, 404)
    return c.json({ ok: true, run })
  })

  // Paged run list. Without `status` it answers exactly as before (finished
  // runs only); every run also carries `trigger` and a server `summary`.
  admin.get('/instance/updates/history', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const query = parseHistoryQuery(c.req.query())
    if ('error' in query) return c.json({ ok: false, ...query }, 400)
    const history = await readHistoryPage(db, query)
    return c.json({ ok: true, runs: history.runs, total: history.total })
  })

  // One page of a run's servers (one row per server) with quick-filter counts.
  admin.get('/instance/updates/runs/:id/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
    const id = c.req.param('id')
    if (!isUuid(id)) return c.json({ ok: false, error: 'upgrade_run_not_found' }, 404)
    const query = parseRunServersQuery(c.req.query())
    if ('error' in query) return c.json({ ok: false, ...query }, 400)
    const page = await readRunServersPage(db, getDaemonCellRegistry(c) ?? null, id, query)
    if (!page) return c.json({ ok: false, error: 'upgrade_run_not_found' }, 404)
    return c.json({ ok: true, ...page })
  })

  admin.get('/instance/updates/servers', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    const page = pageQuery(c)
    const status = c.req.query('status') ?? ''
    const listed = await coordinator.servers({ ...page, status })
    return c.json({ ok: true, servers: listed.servers, total: listed.total })
  })

  admin.get('/instance/updates/settings', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    return c.json({ ok: true, settings: await coordinator.settings() })
  })

  admin.put('/instance/updates/settings', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    const body = await c.req.json().catch(() => null)
    const settings = normalizeUpgradeSettings(body)
    if (!settings) return c.json({ ok: false, error: 'invalid_settings' }, 400)
    await coordinator.saveSettings(settings)
    return c.json({ ok: true, settings })
  })
}

function pageQuery(c: Context<AppEnv>): { offset: number; limit: number } {
  const offset = Number.parseInt(c.req.query('offset') ?? '0', 10)
  const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)
  return {
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50,
  }
}

async function coordinatorFrom(
  c: Context<AppEnv>,
  opts: {
    runtime: 'deno' | 'workers'
    getEnv?: () => Record<string, string | undefined>
  }
): Promise<ReturnType<typeof createUpgradeCoordinator> | Response> {
  const db = getDb(c)
  if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
  const registry = getDaemonCellRegistry(c) ?? null
  const env = resolvePlatformEnv(c, opts)
  const revision = resolveInstanceRevision(env)
  const colocated = registry ? await resolveColocatedServerId(db, registry) : null
  return createUpgradeCoordinator({
    store: createDrizzleUpgradeStore(
      db,
      registry,
      parseUpgradeBatchDefault(env.TURBOPANEL_UPGRADE_BATCH)
    ),
    enqueue: async (serverId, envelope) => {
      if (!registry) throw new Error(NO_DAEMON_ERROR)
      await registry.getCell(serverId).enqueue(envelope)
    },
    runtime: opts.runtime,
    channel: resolveInstanceUpdateChannel(env),
    development: isExplicitDevelopmentMode(),
    now: () => new Date().toISOString(),
    colocatedServerId: colocated,
    instanceInstalled: { version: INSTANCE_VERSION, commit: revision.commit },
    buildLabel: resolveBuildLabel(env),
    verifyTimeoutMs: parseUpgradeVerifyTimeoutMs(env[UPGRADE_VERIFY_TIMEOUT_ENV]),
  })
}

/** A git commit id the console reports (a hex prefix or full sha), or null. */
function readConsoleCommit(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[0-9a-f]{7,64}$/i.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * The Admin > Updates status: installed builds, channel targets and the
 * automatic-update fields. `GET /instance/updates` answers it, and so does
 * Check Now once it has refreshed the manifests.
 */
async function readUpdatesStatus(
  c: Context<AppEnv>,
  opts: { runtime: 'deno' | 'workers'; getEnv?: () => Record<string, string | undefined> }
) {
  const env = resolvePlatformEnv(c, opts)
  const channel = resolveInstanceUpdateChannel(env)
  const revision = resolveInstanceRevision(env)
  const consoleCommit = readConsoleCommit(c.req.query('consoleCommit'))
  const [instanceTarget, uiTarget, daemonTarget, daemon] = await Promise.all([
    resolveUpdateManifest(channel, 'instance'),
    resolveUpdateManifest(channel, 'ui'),
    resolveUpdateManifest(channel, 'daemon'),
    readColocatedDaemon(c),
  ])
  const instanceInstalled = {
    version: INSTANCE_VERSION,
    commit: revision.commit,
  }
  // The exact label of the installed bytes (`0.1.3-canary.417`, `0.1.3-rc.2`),
  // written by the installer from the manifest it installed. INSTANCE_VERSION
  // is the plain deno.json number, which cannot tell a canary from its rc.
  const buildLabel = resolveBuildLabel(env)
  const daemonInstalled = daemon.serverId
    ? { version: daemon.version, commit: daemon.commit, builtAt: daemon.builtAt }
    : null
  const instanceUpdateAvailable = updateAvailableFor(instanceInstalled, instanceTarget)
  const uiUpdateAvailable = opts.runtime === 'deno' && uiBehindTarget(uiTarget, consoleCommit)
  const automatic = await readAutomaticStatus(c, opts, daemonTarget)
  return {
    ok: true,
    channel,
    runtime: opts.runtime,
    managedUpgrade: true,
    updatesManaged: opts.runtime === 'workers',
    ...automatic,
    // The hosted control plane is deploy-managed: only its daemons wait here.
    updateWaiting:
      automatic.daemonsBehind ||
      (opts.runtime === 'deno' && (instanceUpdateAvailable || uiUpdateAvailable)),
    units: {
      instance: {
        installed: buildLabel ? { ...instanceInstalled, label: buildLabel } : instanceInstalled,
        target: instanceTarget,
        uiTarget,
        updateAvailable: instanceUpdateAvailable,
        // The UI ships inside the control-plane install. On a self-hosted
        // control plane it is behind when the console's own bundle differs
        // from the channel's UI build; on Workers the UI is deployed, not
        // installed, so it is never offered here.
        uiUpdateAvailable,
      },
      daemon: {
        installed: daemonInstalled,
        target: daemonTarget,
        serverId: daemon.serverId,
        connected: daemon.connected,
        updateAvailable:
          daemonInstalled !== null && updateAvailableFor(daemonInstalled, daemonTarget),
      },
    },
  }
}

type AutomaticStatus = {
  automatic: true
  updatesPaused: boolean
  pausedAt: string | null
  pausedBy: { userId: string | null; email: string | null; name: string | null } | null
  daemonsBehind: boolean
  nextCheckAt: string | null
  lastCheckAt: string | null
  /** How often this install checks: 60, or less where `TURBOPANEL_UPGRADE_CHECK_MINUTES` is set. */
  checkIntervalMinutes: number
  activeRunId: string | null
}

function pauseFields(
  pause: UpgradePause | null
): Pick<AutomaticStatus, 'updatesPaused' | 'pausedAt' | 'pausedBy'> {
  if (!pause) return { updatesPaused: false, pausedAt: null, pausedBy: null }
  return {
    updatesPaused: true,
    pausedAt: pause.since,
    pausedBy: { userId: pause.byUserId, email: pause.byEmail, name: pause.byName },
  }
}

/**
 * Pause state, the next hourly check, the open run and whether a connected
 * daemon is behind. Each is one indexed, `limit 1` read: never a read of the
 * whole server table per request.
 */
async function readAutomaticStatus(
  c: Context<AppEnv>,
  opts: { runtime: 'deno' | 'workers'; getEnv?: () => Record<string, string | undefined> },
  daemonTarget: UpdateManifestTarget | null
): Promise<AutomaticStatus> {
  const db = getDb(c)
  const env = resolvePlatformEnv(c, opts)
  const checkIntervalMinutes = parseUpgradeCheckMinutes(env[UPGRADE_CHECK_MINUTES_ENV])
  const empty: AutomaticStatus = {
    automatic: true,
    ...pauseFields(null),
    daemonsBehind: false,
    nextCheckAt: null,
    lastCheckAt: null,
    checkIntervalMinutes,
    activeRunId: null,
  }
  if (!db) return empty
  const store = createDrizzleUpgradeStore(
    db,
    null,
    parseUpgradeBatchDefault(env.TURBOPANEL_UPGRADE_BATCH)
  )
  const [pause, schedule, active, daemonsBehind] = await Promise.all([
    getUpgradePause(db),
    readUpgradeCheckSchedule(db),
    db
      .select({ id: upgrade.id })
      .from(upgrade)
      .where(inArray(upgrade.status, [...UPGRADE_ACTIVE_STATUSES]))
      .limit(1),
    daemonTarget?.commit
      ? store.anyDaemonBehind(daemonTarget.commit, daemonTarget.builtAt)
      : Promise.resolve(false),
  ])
  return {
    ...empty,
    ...pauseFields(pause),
    daemonsBehind,
    nextCheckAt: schedule
      ? nextUpgradeCheckAt(schedule, new Date(), checkIntervalMinutes).toISOString()
      : null,
    lastCheckAt: schedule ? latestUpgradeCheckAt(schedule) : null,
    activeRunId: active[0]?.id ?? null,
  }
}

async function readUserName(db: Db, userId: string): Promise<string | null> {
  const rows = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1)
  return rows[0]?.name ?? null
}

/** Pause and Resume go to the activity log (instance-wide: no organization). */
async function auditPause(
  c: Context<AppEnv>,
  db: Db,
  action: 'upgrade.pause' | 'upgrade.resume',
  context: Record<string, unknown>
): Promise<void> {
  const session = c.get('session')
  await recordAudit(db, {
    organizationId: null,
    actorUserId: session?.userId ?? null,
    actorEmail: session?.email ?? null,
    action,
    targetType: 'instance_updates',
    context,
  })
}
