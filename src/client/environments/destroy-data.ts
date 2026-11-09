/**
 * Destroy with "Also Delete the Data Volumes".
 *
 * `POST /environments/:id/stop` takes `{ deleteVolumes: true, confirmName }`.
 * Without it the stop is exactly what it was. With it, before anything is
 * stopped or cancelled:
 *
 * - the caller needs `organization:manage` on the environment (the right an
 *   environment delete needs), on top of the manage gate every Destroy has;
 * - `confirmName` must be the environment's name exactly (400
 *   `confirm_name_required`);
 * - the volumes to remove come from {@link listEnvironmentDataVolumes}, never
 *   from the request;
 * - every server the stop goes to must list
 *   `environment-stop-remove-volumes-v1` (409 `delete_volumes_needs_daemon_update`):
 *   an older daemon ignores `removeVolumes` and would keep the data silently.
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
import { assertCanOr403 } from '../authz/index.ts'
import {
  CONFIRM_NAME_REQUIRED_ERROR,
  confirmationName,
  confirmNameMatches,
} from '../confirm-name.ts'
import { assertCanReadOr403, getOrgId } from '../shared.ts'
import { type EnvironmentDataVolumes, listEnvironmentDataVolumes } from './data-volumes.ts'

export const DELETE_VOLUMES_NEEDS_DAEMON_UPDATE_ERROR = 'delete_volumes_needs_daemon_update'

/** What the stop body asks for. */
export type DestroyRequest = { deleteVolumes: boolean; confirmName?: string }

/** Read the optional stop body; `invalid` for a field of the wrong type. */
export function parseDestroyRequest(body: Record<string, unknown>): DestroyRequest | 'invalid' {
  const { deleteVolumes, confirmName } = body
  if (deleteVolumes !== undefined && typeof deleteVolumes !== 'boolean') return 'invalid'
  if (confirmName !== undefined && typeof confirmName !== 'string') return 'invalid'
  return {
    deleteVolumes: deleteVolumes === true,
    ...(confirmName === undefined ? {} : { confirmName }),
  }
}

/** A server whose daemon cannot delete data volumes yet, by the name people know it by. */
export type OutdatedServer = { serverId: string; name: string }

/** Wire features a server's daemon lists; the stored projection by default. */
export type DaemonFeatureLookup = (db: Db, serverId: string) => Promise<readonly string[]>

async function storedDaemonFeatures(db: Db, serverId: string): Promise<readonly string[]> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features ?? []
}

/** The servers, among `serverIds`, whose daemon does not list the feature. */
export async function serversWithoutVolumeRemoval(
  db: Db,
  serverIds: readonly string[],
  lookup: DaemonFeatureLookup = storedDaemonFeatures
): Promise<OutdatedServer[]> {
  const answers = await Promise.all(
    serverIds.map(async (id) => [id, await lookup(db, id)] as const)
  )
  const outdated = answers
    .filter(([, features]) => !features.includes(STOP_REMOVE_VOLUMES_FEATURE))
    .map(([id]) => id)
  if (outdated.length === 0) return []
  const rows = await db
    .select({ id: server.id, name: server.name, hostname: server.hostname })
    .from(server)
    .where(inArray(server.id, outdated))
  const names = new Map(rows.map((row) => [row.id, row.name?.trim() || row.hostname || row.id]))
  return outdated.map((serverId) => ({ serverId, name: names.get(serverId) ?? serverId }))
}

export function outdatedServersMessage(servers: readonly OutdatedServer[]): string {
  const names = servers.map((entry) => entry.name).join(', ')
  return `Update the daemon on ${names} before deleting data volumes. Nothing was destroyed.`
}

/**
 * Check a Destroy that deletes data and return the volumes to remove, or the
 * refusal. Call it before anything is stopped or cancelled.
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
): Promise<EnvironmentDataVolumes | Response> {
  const denied = await assertCanOr403(c, 'organization:manage', 'environment', params.environmentId)
  if (denied) return denied

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

  const plan = await listEnvironmentDataVolumes(db, params.environmentId)
  if (plan.volumes.length === 0) return plan
  const outdated = await serversWithoutVolumeRemoval(db, params.serverIds, params.lookup)
  if (outdated.length > 0) {
    return c.json(
      {
        error: DELETE_VOLUMES_NEEDS_DAEMON_UPDATE_ERROR,
        message: outdatedServersMessage(outdated),
        servers: outdated,
      },
      409
    )
  }
  return plan
}

/**
 * Register `GET /environments/:id/data-volumes`: what "Also Delete the Data
 * Volumes" would remove, what it keeps and why, and which servers need a
 * daemon update first. Needs read on the environment.
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

    const plan = await listEnvironmentDataVolumes(db, environmentId)
    const serverIds = await loadServerIds(db, environmentId)
    const outdated =
      plan.volumes.length === 0 ? [] : await serversWithoutVolumeRemoval(db, serverIds)
    return c.json({ ...plan, outdatedServers: outdated })
  })
}
