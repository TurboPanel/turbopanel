import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { can, listVisible } from '../authz/index.ts'
import { assertCanManageOr403, assertCanReadOr403, getOrgId } from '../shared.ts'
import { getDb, getDaemonCellRegistry, type Db } from '../../db.ts'
import { parseOrganizationOptions } from '../../lib/organization-options.ts'
import {
  formatServerOsDisplay,
  parseServerOptions,
  resolveEffectiveServerTimezone,
  resolveServerOsLogoKey,
} from '../../lib/db/server-metadata.ts'
import { cachedServerDetailReadModel } from '../../query-cache/read-models/server-detail.ts'
import {
  fetchDaemonServerCell,
} from '../../daemon/cell/server-diagnostics.ts'
import { resolveFleetPresence } from '../../daemon/cell/fleet-presence.ts'
import { readProjectionsForServers } from '../../daemon/cell/postgres-projection.ts'
import {
  onDaemonUpdateQueued,
  onDaemonUpdateReset,
  onDaemonUpdateResult,
  onDaemonUpdateExpired,
  repairStaleProjectedUpdate,
} from '../../daemon/cell/control-plane-monitor.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { UpdateProjection } from '../../daemon/authn/daemon-state.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../../daemon/cell/protocol.ts'
import { clearServerDaemonState } from '../../daemon/authn/server-identity-db.ts'
import { organization, server, license } from '../../lib/db/schema.ts'
import { resolveTrunkManifest } from '../../lib/update/manifest.ts'
import { revokeLicense } from '../authn/license.ts'
import { compatLogWarn } from '../../log-compat.ts'
import {
  hierarchyDeleteHasChildrenResponse,
  runHierarchyDelete,
} from '../hierarchy-delete.ts'
import {
  colocatedServerDeleteBlockedReason,
  listServerDeleteBlockers,
  serverDeleteBlockersResponse,
} from './delete-guards.ts'
import {
  resolveColocatedServerIdSet,
} from './colocated.ts'
import {
  colocatedServerUpdateBlockedReason,
  isStaleProjectedUpdating,
  resolveServerUpdateStatus,
  type ServerUpdateCommit,
} from './update-status.ts'
import { UPDATE_REQUEST_TTL_MS } from '../../lib/update/constants.ts'
import { registerServerCommandRoutes } from './commands-routes.ts'
import { registerServerMetricsRoutes } from './metrics-routes.ts'
import { cachedServersListReadModel } from '../../query-cache/read-models/servers-list.ts'

const UPDATE_CHANNEL = 'trunk'
const UPDATE_REQUEST_TTL_SECONDS = 300

const STATUS_CACHE_CONTROL = 'private, max-age=5'
const STATUS_CACHE_MAX_AGE_MS = 5_000

type QueuedUpdateResult = {
  ok: true
  queued: true
  status: 'updating'
  serverId: string
  requestId: string
  channel: typeof UPDATE_CHANNEL
}

type QueueUpdateFailure = {
  ok: false
  error: string
}

async function queueServerUpdate(
  registry: DaemonCellRegistry,
  db: Db,
  serverId: string,
): Promise<QueuedUpdateResult | QueueUpdateFailure> {
  const presence = await resolveFleetPresence(db, registry, [serverId])
  const live = presence.get(serverId)
  if (!live?.connected) {
    return { ok: false, error: 'Daemon not connected' }
  }
  const colocatedIds = await resolveColocatedServerIdSet(db, registry, [serverId])
  if (colocatedIds.has(serverId)) {
    return { ok: false, error: colocatedServerUpdateBlockedReason() }
  }

  const requestId = generateRequestId()
  const envelope: DaemonOutboundEnvelope = {
    kind: 'update',
    deliveryId: generateDeliveryId(),
    requestId,
    at: new Date().toISOString(),
    channel: UPDATE_CHANNEL,
  }

  await registry.getCell(serverId).enqueue(envelope, {
    ttlSeconds: UPDATE_REQUEST_TTL_SECONDS,
  })

  await onDaemonUpdateQueued(db, serverId, requestId, UPDATE_CHANNEL, envelope.at)

  return {
    ok: true,
    queued: true,
    status: 'updating',
    serverId,
    requestId,
    channel: UPDATE_CHANNEL,
  }
}

function currentCommitFromAgent(
  agent: { commit?: string; buildId?: string; builtAt?: string } | undefined,
): ServerUpdateCommit | null {
  return agent?.commit
    ? {
      commit: agent.commit,
      buildId: agent.buildId ?? '',
      builtAt: agent.builtAt ?? '',
    }
    : null
}

async function repairProjectedUpdateIfStale(
  db: Db,
  serverId: string,
  projectedUpdate: UpdateProjection | null | undefined,
  current: ServerUpdateCommit | null,
  targetCommit?: string,
): Promise<UpdateProjection | null | undefined> {
  if (projectedUpdate?.status !== 'updating') {
    return projectedUpdate
  }

  const repaired = await repairStaleProjectedUpdate(
    db,
    serverId,
    projectedUpdate,
    {
      currentCommit: current?.commit,
      targetCommit,
      updateTtlMs: UPDATE_REQUEST_TTL_MS,
    },
  )
  if (!repaired) return projectedUpdate

  if (targetCommit && current?.commit === targetCommit) {
    return {
      status: 'done',
      requestId: projectedUpdate.requestId,
      channel: projectedUpdate.channel,
      queuedAt: projectedUpdate.queuedAt,
      finishedAt: new Date().toISOString(),
    }
  }

  return { status: 'idle' }
}

async function assertServerDeletable(
  c: Context,
  db: Db,
  registry: DaemonCellRegistry,
  serverId: string,
  organizationId: string,
): Promise<Response | null> {
  const colocatedIds = await resolveColocatedServerIdSet(db, registry, [serverId])
  if (colocatedIds.has(serverId)) {
    return c.json({ error: colocatedServerDeleteBlockedReason() }, 403)
  }

  const blockers = await listServerDeleteBlockers(db, serverId, organizationId)
  if (blockers.length > 0) {
    return serverDeleteBlockersResponse(c, blockers)
  }

  return null
}

async function purgeServerDaemonCell(
  registry: DaemonCellRegistry,
  serverId: string,
): Promise<string | null> {
  try {
    await registry.getCell(serverId).purge()
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Failed to purge daemon cell for server ${serverId}: ${message}`)
    return message
  }
}

/**
 * Soft-revokes the registration key that enrolled this server.
 * Licenses are one-shot: deleting the server retires the key on every runtime
 * so it cannot enroll a replacement host.
 */
async function revokeBoundLicenseOnServerDelete(
  db: Db,
  serverId: string,
  licenseId: string | null,
  organizationId: string,
): Promise<void> {
  if (!licenseId) return

  const invalidated = await revokeLicense(db, licenseId, organizationId)
  if (!invalidated) {
    compatLogWarn(
      'servers',
      `server ${serverId} deleted but license ${licenseId} was not invalidated (missing, wrong org, or already revoked)`,
    )
  }
}

export function registerServerRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server routes')
  }
  const secrets = opts.secrets

  router.use('/servers', createSessionMiddleware(secrets))
  router.use('/servers/*', createSessionMiddleware(secrets))

  router.get('/servers', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({ servers: [] })
    }

    let display
    try {
      display = await cachedServersListReadModel(c, {
        userId: session.userId,
        organizationId,
        visibleIds,
      })
    } catch {
      return c.json({ error: 'Database unavailable' }, 503)
    }

    const presence = new Map(display.presence.map((live) => [live.serverId, live]))
    const colocatedIds = new Set(display.colocatedIds)

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    const orgOptions = parseOrganizationOptions(orgRow?.options)

    return c.json({
      servers: display.rows.map((row) => {
        const live = presence.get(row.id)
        const os = live?.os ?? null
        const effective = resolveEffectiveServerTimezone(
          parseServerOptions(row.options),
          orgOptions,
        )
        return {
          ...row,
          connected: live?.connected ?? false,
          hostname: live?.hostname ?? null,
          remoteAddress: live?.remoteAddress ?? null,
          colocatedWithInstance: colocatedIds.has(row.id),
          lastInboundAt: live?.lastInboundAt ?? null,
          connectedAt: live?.connectedAt ?? null,
          geo: live?.geo ?? null,
          os,
          osDisplay: formatServerOsDisplay(os),
          osLogo: resolveServerOsLogoKey(os),
          addresses: live?.addresses ?? null,
          timeSync: live?.timeSync ?? null,
          timezone: effective.timezone,
          timezoneSource: effective.source,
          licenseId: row.licenseId ?? null,
        }
      }),
    })
  })

  router.get('/servers/updates', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    if (visibleIds.length === 0) {
      return c.json({
        ok: true,
        channel: UPDATE_CHANNEL,
        target: null,
        targetStatus: 'unknown' as const,
        targetError: 'Could not resolve trunk channel manifest',
        servers: [],
      })
    }

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, visibleIds)
    const projections = await readProjectionsForServers(db, visibleIds)
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, visibleIds)
    const targetManifest = await resolveTrunkManifest()
    const target = targetManifest
      ? {
        commit: targetManifest.commit,
        buildId: targetManifest.buildId,
        builtAt: targetManifest.builtAt,
        manifestUrl: targetManifest.manifestUrl,
      }
      : null
    const targetStatus = target ? 'ok' as const : 'unknown' as const
    const targetError = target
      ? undefined
      : 'Could not resolve trunk channel manifest'

    const servers = await Promise.all(
      visibleIds.map(async (serverId) => {
        const current = currentCommitFromAgent(presence.get(serverId)?.agent)
        let projection = projections.get(serverId)
        const repairedUpdate = await repairProjectedUpdateIfStale(
          db,
          serverId,
          projection?.update ?? null,
          current,
          targetManifest?.commit,
        )
        const resolved = await resolveServerUpdateStatus({
          serverId,
          current,
          targetManifest,
          colocatedWithInstance: colocatedIds.has(serverId),
          projectedUpdate: repairedUpdate ?? null,
        })
        return {
          serverId,
          current,
          colocatedWithInstance: colocatedIds.has(serverId),
          ...resolved,
        }
      }),
    )

    return c.json({
      ok: true,
      channel: UPDATE_CHANNEL,
      target,
      targetStatus,
      targetError,
      servers,
    })
  })

  router.post('/servers/updates', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const visibleIds = await listVisible(db, {
      kind: 'server',
      userId: session.userId,
      organizationId,
    })

    const targetManifest = await resolveTrunkManifest()
    const presence = await resolveFleetPresence(db, registry, visibleIds)
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, visibleIds)

    const results = await Promise.all(
      visibleIds.map(async (serverId) => {
        const manageable = await can(
          db,
          session.userId,
          'organization:manage',
          'server',
          serverId,
        )
        if (!manageable) {
          return {
            serverId,
            ok: false,
            error: 'Forbidden',
          }
        }

        if (!presence.get(serverId)?.connected) {
          return {
            serverId,
            ok: false,
            error: 'Daemon not connected',
          }
        }

        if (colocatedIds.has(serverId)) {
          return {
            serverId,
            ok: false,
            error: colocatedServerUpdateBlockedReason(),
          }
        }

        const current = currentCommitFromAgent(presence.get(serverId)?.agent)
        const updateAvailable = targetManifest
          ? current?.commit !== targetManifest.commit
          : false
        if (!updateAvailable) {
          return {
            serverId,
            ok: false,
            error: targetManifest ? 'Up to date' : 'Target unavailable',
          }
        }

        const queued = await queueServerUpdate(registry, db, serverId)
        if (!queued.ok) {
          return { serverId, ok: false, error: queued.error }
        }

        return {
          serverId,
          ok: true,
          queued: true,
          status: queued.status,
          requestId: queued.requestId,
          channel: queued.channel,
        }
      }),
    )

    return c.json({
      ok: results.every((result) => result.ok),
      results,
    })
  })

  // DEBUG/DIAGNOSTIC ENDPOINT — hits the Durable Object directly via fetchDaemonServerCell.
  // Must NOT be polled by normal UI. Only call on explicit user action (e.g. a manual Refresh button).
  // Future: restrict to admin or add rate limiting before exposing broadly.
  router.get('/servers/:id/cell', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const result = await fetchDaemonServerCell(db, registry, id)
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }
    return c.json(result)
  })

  router.post('/servers/:id/update/reset', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    try {
      const presence = await resolveFleetPresence(db, registry, [id])
      const projections = await readProjectionsForServers(db, [id])
      const colocatedIds = await resolveColocatedServerIdSet(db, registry, [id])
      const current = currentCommitFromAgent(presence.get(id)?.agent)
      const targetManifest = await resolveTrunkManifest()
      const projectedUpdate = projections.get(id)?.update
      const stale = isStaleProjectedUpdating({
        projectedUpdate,
        currentCommit: current?.commit,
        targetCommit: targetManifest?.commit,
        updateTtlMs: UPDATE_REQUEST_TTL_MS,
      })

      const { cleared } = await registry.getCell(id).clearUpdateStatus({
        allowStale: stale,
        currentCommit: current?.commit,
        targetCommit: targetManifest?.commit,
        queuedAt: projectedUpdate?.queuedAt,
        updateTtlMs: UPDATE_REQUEST_TTL_MS,
      })

      if (stale && projectedUpdate?.status === 'updating') {
        const finishedAt = new Date().toISOString()
        const requestId = projectedUpdate.requestId ?? ''
        if (targetManifest && current?.commit === targetManifest.commit) {
          await onDaemonUpdateResult(db, id, requestId, true, finishedAt)
        } else {
          await onDaemonUpdateExpired(db, id, requestId, finishedAt)
        }
      } else {
        await onDaemonUpdateReset(db, id)
      }

      const resolved = await resolveServerUpdateStatus({
        serverId: id,
        current,
        targetManifest,
        colocatedWithInstance: colocatedIds.has(id),
        projectedUpdate: { status: 'idle' },
      })

      return c.json({
        ok: true,
        serverId: id,
        cleared,
        channel: UPDATE_CHANNEL,
        current,
        colocatedWithInstance: colocatedIds.has(id),
        ...resolved,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'update in progress') {
        return c.json({ ok: false, error: message }, 409)
      }
      return c.json({ ok: false, error: message }, 500)
    }
  })

  router.get('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    const presence = await resolveFleetPresence(db, registry, [id])
    const projections = await readProjectionsForServers(db, [id])
    const colocatedIds = await resolveColocatedServerIdSet(db, registry, [id])
    const current = currentCommitFromAgent(presence.get(id)?.agent)
    const targetManifest = await resolveTrunkManifest()
    const repairedUpdate = await repairProjectedUpdateIfStale(
      db,
      id,
      projections.get(id)?.update ?? null,
      current,
      targetManifest?.commit,
    )

    const resolved = await resolveServerUpdateStatus({
      serverId: id,
      current,
      targetManifest,
      colocatedWithInstance: colocatedIds.has(id),
      projectedUpdate: repairedUpdate ?? null,
    })

    return c.json({
      ok: true,
      serverId: id,
      channel: UPDATE_CHANNEL,
      current,
      colocatedWithInstance: colocatedIds.has(id),
      ...resolved,
    })
  })

  router.post('/servers/:id/update', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) return c.json({ error: 'Daemon cell registry unavailable' }, 503)

    const queued = await queueServerUpdate(registry, db, id)
    if (!queued.ok) {
      const status = queued.error === colocatedServerUpdateBlockedReason()
        ? 403
        : 404
      return c.json({ ok: false, error: queued.error }, status)
    }

    return c.json({ ok: true, ...queued })
  })

  router.get('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const [serverRow] = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!serverRow) return c.json({ error: 'Not found' }, 404)

    let display
    try {
      display = await cachedServerDetailReadModel(c, {
        organizationId,
        serverId: id,
      })
    } catch {
      return c.json({ error: 'Database unavailable' }, 503)
    }
    if (!display) return c.json({ error: 'Not found' }, 404)

    const [orgRow] = await db
      .select({ options: organization.options })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    const orgOptions = parseOrganizationOptions(orgRow?.options)
    const live = display.presence
    const os = live?.os ?? null
    const effective = resolveEffectiveServerTimezone(
      parseServerOptions(display.row.options),
      orgOptions,
    )

    return c.json({
      ok: true,
      server: {
        ...display.row,
        connected: live?.connected ?? false,
        hostname: live?.hostname ?? null,
        remoteAddress: live?.remoteAddress ?? null,
        lastInboundAt: live?.lastInboundAt ?? null,
        connectedAt: live?.connectedAt ?? null,
        os,
        osDisplay: formatServerOsDisplay(os),
        osLogo: resolveServerOsLogoKey(os),
        geo: live?.geo ?? null,
        addresses: live?.addresses ?? null,
        timeSync: live?.timeSync ?? null,
        timezone: effective.timezone,
        timezoneSource: effective.source,
        orgDefaultTimezone: orgOptions.defaultServerTimezone ?? null,
        enforceServerTimezone: orgOptions.enforceServerTimezone ?? false,
        colocatedWithInstance: display.colocatedWithInstance,
        licenseId: display.row.licenseId ?? null,
      },
    })
  })

  router.delete('/servers/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const [row] = await db
      .select({ id: server.id })
      .from(server)
      .where(and(eq(server.id, id), eq(server.organizationId, organizationId)))
      .limit(1)
    if (!row) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const registry = getDaemonCellRegistry(c)
    if (!registry) {
      return c.json({ error: 'Daemon cell registry unavailable' }, 503)
    }

    const blocked = await assertServerDeletable(c, db, registry, id, organizationId)
    if (blocked) return blocked

    const [boundLicense] = await db
      .select({ id: license.id })
      .from(license)
      .where(eq(license.serverId, id))
      .limit(1)

    const result = await runHierarchyDelete(db, async (tx) => {
      await tx.delete(server).where(eq(server.id, id))
    })
    if (result === 'has_children') {
      return hierarchyDeleteHasChildrenResponse(c)
    }

    await clearServerDaemonState(db, id)

    const purgeError = await purgeServerDaemonCell(registry, id)
    await revokeBoundLicenseOnServerDelete(
      db,
      id,
      boundLicense?.id ?? null,
      organizationId,
    )

    if (purgeError) {
      return c.json({
        ok: false,
        serverId: id,
        deleted: true,
        error: `Server deleted but daemon cell purge failed: ${purgeError}`,
      }, 500)
    }

    return c.json({ ok: true, serverId: id })
  })

  registerServerCommandRoutes(router, opts)
  registerServerMetricsRoutes(router, opts)
}
