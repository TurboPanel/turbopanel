import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { resolveBuildLabel, resolveInstanceRevision } from '../app/build-info.ts'
import { INSTANCE_VERSION } from '../app/version.ts'
import { resolveColocatedServerId } from '../client/authn/install-state.ts'
import { resolveInstanceUpdateChannel, type UpdateChannel } from '../contracts/update-channel.ts'
import { getDaemonCellRegistry, getDb } from '../db/connection.ts'
import { resolveUpdateManifest } from '../features/update/manifest.ts'
import { isExplicitDevelopmentMode } from '../lib/dev-mode.ts'
import { createUpgradeCoordinator } from '../features/upgrades/coordinator.ts'
import { createDrizzleUpgradeStore } from '../features/upgrades/store.ts'
import { uiBehindTarget, updateAvailableFor } from '../features/upgrades/target.ts'
import { normalizeUpgradeSettings } from '../features/settings/upgrade-settings.ts'
import { resolvePlatformEnv } from './routes-helpers.ts'

const INSTANCE_UPDATE_RUNTIME_ERROR = 'control-plane update is not applicable on this runtime'

const NO_DAEMON_ERROR = 'no co-located daemon connected to update the control plane'

const DAEMON_DISCONNECTED_ERROR = 'co-located daemon disconnected'

type ColocatedDaemon = {
  serverId: string | null
  connected: boolean
  version: string | null
  commit: string | null
  builtAt: string | null
}

function isInstancePackageChannel(channel: UpdateChannel): channel is 'canary' | 'rc' | 'release' {
  return channel === 'canary' || channel === 'rc' || channel === 'release'
}

function instanceChannelError(channel: UpdateChannel): string {
  return `This control plane follows ${channel}, which has no control-plane package. Use canary, rc, or release.`
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
 * Installed versions, channel targets, and the managed upgrade run API.
 *
 * `POST …/instance` and `POST …/daemon` start the same guarded run as
 * `POST …/runs`. The control-plane row is `INSTANCE_VERSION`.
 */
export function registerInstanceUpdatesAdminRoutes(
  admin: Hono<AppEnv>,
  opts: {
    runtime: 'deno' | 'workers'
    getEnv?: () => Record<string, string | undefined>
  }
): void {
  admin.get('/instance/updates', async (c) => {
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
    return c.json({
      ok: true,
      channel,
      runtime: opts.runtime,
      managedUpgrade: true,
      updatesManaged: opts.runtime === 'workers',
      units: {
        instance: {
          installed: buildLabel ? { ...instanceInstalled, label: buildLabel } : instanceInstalled,
          target: instanceTarget,
          uiTarget,
          updateAvailable: updateAvailableFor(instanceInstalled, instanceTarget),
          // The UI ships inside the control-plane install. On a self-hosted
          // control plane it is behind when the console's own bundle differs
          // from the channel's UI build; on Workers the UI is deployed, not
          // installed, so it is never offered here.
          uiUpdateAvailable: opts.runtime === 'deno' && uiBehindTarget(uiTarget, consoleCommit),
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
    })
  })

  admin.post('/instance/updates/instance', async (c) => {
    if (opts.runtime === 'workers') {
      return c.json({ ok: false, error: INSTANCE_UPDATE_RUNTIME_ERROR }, 422)
    }
    const channel = resolveInstanceUpdateChannel(resolvePlatformEnv(c, opts))
    if (!isInstancePackageChannel(channel)) {
      return c.json({ ok: false, error: instanceChannelError(channel) }, 422)
    }
    const refused = await refuseWithoutConnectedDaemon(c)
    if (refused) return refused
    return await startGuardedRun(c, opts)
  })

  admin.post('/instance/updates/daemon', async (c) => {
    if (opts.runtime === 'deno') {
      const refused = await refuseWithoutConnectedDaemon(c)
      if (refused) return refused
    }
    return await startGuardedRun(c, opts)
  })

  admin.post('/instance/updates/preflight', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    return c.json(await coordinator.preflight())
  })

  admin.post('/instance/updates/runs', async (c) => {
    return await startGuardedRun(c, opts)
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

  admin.post('/instance/updates/check', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    await coordinator.tick({ resolveManifests: true })
    return c.json({ ok: true })
  })

  admin.get('/instance/updates/history', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    const page = pageQuery(c)
    const history = await coordinator.history(page.offset, page.limit)
    return c.json({ ok: true, runs: history.runs, total: history.total })
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

  admin.post('/instance/updates/steps/:id/retry', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    const result = await coordinator.retry(c.req.param('id'))
    if (!result.ok) return c.json(result, 409)
    return c.json(result)
  })

  admin.post('/instance/updates/runs/:id/cancel', async (c) => {
    const coordinator = await coordinatorFrom(c, opts)
    if (coordinator instanceof Response) return coordinator
    const result = await coordinator.cancel(c.req.param('id'))
    if (!result.ok) {
      const status = result.error === 'upgrade_run_not_found' ? 404 : 409
      return c.json(result, status)
    }
    return c.json(result)
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
    store: createDrizzleUpgradeStore(db, registry),
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
  })
}

/** A git commit id the console reports (a hex prefix or full sha), or null. */
function readConsoleCommit(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^[0-9a-f]{7,64}$/i.test(trimmed) ? trimmed.toLowerCase() : null
}

async function startGuardedRun(
  c: Context<AppEnv>,
  opts: {
    runtime: 'deno' | 'workers'
    getEnv?: () => Record<string, string | undefined>
  }
): Promise<Response> {
  const coordinator = await coordinatorFrom(c, opts)
  if (coordinator instanceof Response) return coordinator
  const startedBy = c.get('session')?.userId ?? null
  const body = await c.req.json().catch(() => null)
  const runId = typeof body?.runId === 'string' ? body.runId : undefined
  const consoleCommit = opts.runtime === 'deno' ? readConsoleCommit(body?.consoleCommit) : null
  const result = await coordinator.start({
    source: 'manual',
    startedBy,
    runId,
    consoleCommit,
  })
  if (!result.ok) {
    return c.json({ ok: false, error: result.error, blockers: result.blockers }, 409)
  }
  return c.json({ ok: true, dispatched: true, runId: result.runId }, 202)
}

async function refuseWithoutConnectedDaemon(c: Context<AppEnv>): Promise<Response | null> {
  const db = getDb(c)
  if (!db) return c.json({ ok: false, error: 'Database unavailable' }, 503)
  const registry = getDaemonCellRegistry(c)
  if (!registry) {
    return c.json({ ok: false, error: 'Daemon cell registry unavailable' }, 503)
  }
  const daemon = await readColocatedDaemon(c)
  if (!daemon.serverId) {
    return c.json({ ok: false, error: NO_DAEMON_ERROR }, 503)
  }
  if (!daemon.connected) {
    return c.json({ ok: false, error: DAEMON_DISCONNECTED_ERROR }, 503)
  }
  return null
}
