/**
 * Destroy with "Also Delete the Data Volumes".
 *
 * `POST /environments/:id/stop` takes `{ deleteVolumes: true, confirmName,
 * volumeIds }`. Without it the stop is exactly what it was. With it, before
 * anything is stopped or cancelled:
 *
 * - `confirmName` must be the environment's name exactly (400
 *   `confirm_name_required`);
 * - the volumes to remove come from {@link listEnvironmentDataVolumes}, never
 *   from the request; `volumeIds` is the list the person was shown, and a
 *   list that changed since answers 409 `data_volumes_changed` with the new one;
 * - every server the stop goes to must list
 *   `environment-stop-remove-volumes-v1` (409 `delete_volumes_needs_daemon_update`):
 *   an older daemon ignores `removeVolumes` and would keep the data silently.
 *
 * The right needed is the one every Destroy already checks (manage on the
 * environment, which is the right an environment delete needs), plus the
 * `environment.data.delete` step-up when the organization asks for one.
 *
 * A volume is removed on the servers the stop goes to. A Docker copy recorded
 * on another server (the environment moved away from it) stays, and both the
 * dialog and the audit row name that server.
 *
 * `GET /environments/:id/data-volumes` returns the same list for the dialog.
 */
import { eq, inArray } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDb } from '../../db/connection.ts'
import { environment, server } from '../../db/schema.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import { STOP_REMOVE_VOLUMES_FEATURE } from '../../lib/version-wire.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { resolveEntityOrganizationId } from '../authz/create-access-grant.ts'
import {
  CONFIRM_NAME_REQUIRED_ERROR,
  confirmationName,
  confirmNameMatches,
} from '../confirm-name.ts'
import { assertCanReadOr403, getOrgId } from '../shared.ts'
import { type KeptDataVolume, listEnvironmentDataVolumes } from './data-volumes.ts'

export const DELETE_VOLUMES_NEEDS_DAEMON_UPDATE_ERROR = 'delete_volumes_needs_daemon_update'
export const DATA_VOLUMES_CHANGED_ERROR = 'data_volumes_changed'

/** What the stop body asks for. */
export type DestroyRequest = {
  deleteVolumes: boolean
  confirmName?: string
  /** The storage ids the person was shown; required with `deleteVolumes`. */
  volumeIds?: string[]
}

/** Read the optional stop body; `invalid` for a field of the wrong type. */
export function parseDestroyRequest(body: Record<string, unknown>): DestroyRequest | 'invalid' {
  const { deleteVolumes, confirmName, volumeIds } = body
  if (deleteVolumes !== undefined && typeof deleteVolumes !== 'boolean') return 'invalid'
  if (confirmName !== undefined && typeof confirmName !== 'string') return 'invalid'
  if (
    volumeIds !== undefined &&
    (!Array.isArray(volumeIds) || volumeIds.some((id) => typeof id !== 'string'))
  ) {
    return 'invalid'
  }
  if (deleteVolumes === true && volumeIds === undefined) return 'invalid'
  return {
    deleteVolumes: deleteVolumes === true,
    ...(confirmName === undefined ? {} : { confirmName }),
    ...(volumeIds === undefined ? {} : { volumeIds: volumeIds as string[] }),
  }
}

/** A server, by the name people know it by. */
export type NamedServer = { serverId: string; name: string }

/** One volume a Destroy that deletes data removes, and where a copy of it stays. */
export type PlannedDataVolume = {
  storageId: string
  name: string
  /** Servers with a recorded copy that the stop does not go to; their copies stay. */
  staysOn: NamedServer[]
}

/** The dialog's list and the stop's plan: one shape for both. */
export type DestroyDataPlan = {
  volumes: PlannedDataVolume[]
  kept: KeptDataVolume[]
  /** Servers whose daemon must be updated before data can be deleted. */
  outdatedServers: NamedServer[]
}

/** Wire features a server's daemon lists; the stored projection by default. */
export type DaemonFeatureLookup = (db: Db, serverId: string) => Promise<readonly string[]>

export async function storedDaemonFeatures(db: Db, serverId: string): Promise<readonly string[]> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features ?? []
}

async function serverNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: server.id, name: server.name, hostname: server.hostname })
    .from(server)
    .where(inArray(server.id, [...ids]))
  return new Map(rows.map((row) => [row.id, row.name?.trim() || row.hostname || row.id]))
}

/** The servers, among `serverIds`, whose daemon does not list the feature. */
export async function serversWithoutVolumeRemoval(
  db: Db,
  serverIds: readonly string[],
  lookup: DaemonFeatureLookup = storedDaemonFeatures
): Promise<NamedServer[]> {
  const answers = await Promise.all(
    serverIds.map(async (id) => [id, await lookup(db, id)] as const)
  )
  const outdated = answers
    .filter(([, features]) => !features.includes(STOP_REMOVE_VOLUMES_FEATURE))
    .map(([id]) => id)
  const names = await serverNames(db, outdated)
  return outdated.map((serverId) => ({ serverId, name: names.get(serverId) ?? serverId }))
}

export function outdatedServersMessage(servers: readonly NamedServer[]): string {
  const names = servers.map((entry) => entry.name).join(', ')
  return `Update the daemon on ${names} before deleting data volumes. Nothing was destroyed.`
}

/** True when `shown` names exactly the volumes in `volumes` (order and repeats do not count). */
export function sameVolumeList(
  shown: readonly string[] | undefined,
  volumes: readonly { storageId: string }[]
): boolean {
  const expected = new Set(volumes.map((volume) => volume.storageId))
  const given = new Set(shown ?? [])
  return given.size === expected.size && [...given].every((id) => expected.has(id))
}

/** The list for an environment whose stop goes to `serverIds`. */
export async function buildDestroyDataPlan(
  db: Db,
  environmentId: string,
  serverIds: readonly string[],
  lookup?: DaemonFeatureLookup
): Promise<DestroyDataPlan> {
  const listed = await listEnvironmentDataVolumes(db, environmentId)
  const targets = new Set(serverIds)
  const elsewhereIds = [
    ...new Set(listed.volumes.flatMap((v) => v.copyServerIds.filter((id) => !targets.has(id)))),
  ]
  const names = await serverNames(db, elsewhereIds)
  const volumes = listed.volumes.map(({ storageId, name, copyServerIds }) => ({
    storageId,
    name,
    staysOn: copyServerIds
      .filter((id) => !targets.has(id))
      .map((serverId) => ({ serverId, name: names.get(serverId) ?? serverId })),
  }))
  const outdatedServers =
    volumes.length === 0 ? [] : await serversWithoutVolumeRemoval(db, serverIds, lookup)
  return { volumes, kept: listed.kept, outdatedServers }
}

/**
 * Check a Destroy that deletes data and return the plan, or the refusal. Call
 * it before anything is stopped or cancelled.
 */
export async function planDestroyData(
  c: Context<AppEnv>,
  db: Db,
  params: {
    environmentId: string
    serverIds: readonly string[]
    request: DestroyRequest
    lookup?: DaemonFeatureLookup
  }
): Promise<DestroyDataPlan | Response> {
  const [named] = await db
    .select({ name: environment.name })
    .from(environment)
    .where(eq(environment.id, params.environmentId))
    .limit(1)
  const expected = confirmationName(named?.name, params.environmentId)
  if (!confirmNameMatches(params.request.confirmName, expected)) {
    return c.json(
      {
        error: CONFIRM_NAME_REQUIRED_ERROR,
        message: 'Type the environment name to delete its data volumes.',
      },
      400
    )
  }

  const plan = await buildDestroyDataPlan(db, params.environmentId, params.serverIds, params.lookup)
  if (!sameVolumeList(params.request.volumeIds, plan.volumes)) {
    return c.json(
      {
        error: DATA_VOLUMES_CHANGED_ERROR,
        message:
          'The data volumes changed since the list was shown. Check the new list. Nothing was destroyed.',
        ...plan,
      },
      409
    )
  }
  if (plan.outdatedServers.length > 0) {
    return c.json(
      {
        error: DELETE_VOLUMES_NEEDS_DAEMON_UPDATE_ERROR,
        message: outdatedServersMessage(plan.outdatedServers),
        servers: plan.outdatedServers,
      },
      409
    )
  }
  return plan
}

/**
 * Register `GET /environments/:id/data-volumes`: what "Also Delete the Data
 * Volumes" would remove, what it keeps and why, where a copy stays, and which
 * servers need a daemon update first. Needs read on the environment.
 */
export function registerEnvironmentDataVolumeRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
  loadServerIds: (db: Db, environmentId: string) => Promise<string[]>
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for environment data volume routes')
  }
  router.use('/environments/:id/data-volumes', createSessionMiddleware(opts.secrets))

  router.get('/environments/:id/data-volumes', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)
    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const environmentId = c.req.param('id')
    const entityOrgId = await resolveEntityOrganizationId(db, 'environment', environmentId)
    if (!entityOrgId || entityOrgId !== orgResult) return c.json({ error: 'Not found' }, 404)
    const denied = await assertCanReadOr403(c, 'environment', environmentId)
    if (denied) return denied

    const serverIds = await loadServerIds(db, environmentId)
    return c.json(await buildDestroyDataPlan(db, environmentId, serverIds))
  })
}
