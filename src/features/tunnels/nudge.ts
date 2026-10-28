/**
 * Send forwarding tables right away when something they are built from changed
 * (a site, its names, a deploy, a server, an address), instead of waiting for
 * the periodic sweep. The sweep still runs and sends whatever this missed.
 *
 * The connector list (`connector-sync.ts`) goes out with the tables, so a server
 * that gains or loses a tunnel to carry starts or stops its connector too.
 *
 * Nothing here throws: a failure is logged and the sweep tries again. The work
 * is bounded (one organization, a capped number of servers per pass, nothing
 * sent for a table that has not changed) and uses only the database and the
 * command queue. Request handlers run it after the response
 * (`nudgeTunnelRoutesAfterResponse`), never inside the request.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { environment, project, server, tunnel } from '../../db/schema.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import type { CommandQueue } from '../commands/queue.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { syncOrganizationTunnelConnectors } from './connector-sync.ts'
import { relinkDoorwayHostings } from './doorway-links.ts'
import { serversToCheck, syncServerQuietly, type TunnelSyncDeps } from './sync.ts'

/** The most servers one change sends to; the sweep reaches the rest. */
export const TUNNEL_NUDGE_MAX_SERVERS = 40

/** The queue and secrets a send needs, or null when any is missing (nothing is sent then). */
export function tunnelSyncDepsFrom(fields: {
  commandQueue: CommandQueue | undefined
  secretsConfig: SecretsConfig | undefined
  dataEncryptionSecrets: DerivedSecretsConfig | undefined
}): TunnelSyncDeps | null {
  const { commandQueue, secretsConfig, dataEncryptionSecrets } = fields
  if (!commandQueue || !secretsConfig || !dataEncryptionSecrets) return null
  return { commandQueue, secretsConfig, dataEncryptionSecrets }
}

/** Does the organization have a tunnel, or a server that was once sent a table or a connector list? */
async function hasTunnelWork(db: Db, organizationId: string): Promise<boolean> {
  const [tunnelRow] = await db
    .select({ id: tunnel.id })
    .from(tunnel)
    .where(eq(tunnel.organizationId, organizationId))
    .limit(1)
  if (tunnelRow) return true
  const [serverRow] = await db
    .select({ id: server.id })
    .from(server)
    .where(
      and(
        eq(server.organizationId, organizationId),
        sql`(${server.metadata} -> 'tunnelRoutes' IS NOT NULL OR ${server.metadata} -> 'tunnelConnectors' IS NOT NULL)`
      )
    )
    .limit(1)
  return serverRow !== undefined
}

/** Run one pass; a failure is logged and the other pass still runs. */
async function quietly(organizationId: string, pass: () => Promise<unknown>): Promise<void> {
  try {
    await pass()
  } catch (err) {
    compatLogWarn(
      'tunnel-sync',
      `organization ${organizationId}: ${err instanceof Error ? err.message : err}`
    )
  }
}

/**
 * Bring the servers of the organization up to date: forwarding tables first,
 * then connector lists. Each pass stops after {@link TUNNEL_NUDGE_MAX_SERVERS}
 * servers. Never throws.
 */
export async function nudgeTunnelRoutes(
  db: Db,
  deps: TunnelSyncDeps | null,
  organizationId: string
): Promise<void> {
  if (!deps) return
  let work = false
  await quietly(organizationId, async () => {
    work = await hasTunnelWork(db, organizationId)
  })
  if (!work) return
  await quietly(organizationId, async () => {
    await relinkDoorwayHostings(db, organizationId)
    const serverIds = (await serversToCheck(db, organizationId)).slice(0, TUNNEL_NUDGE_MAX_SERVERS)
    await forEachSequential(serverIds, async (serverId) => {
      await syncServerQuietly(db, deps, organizationId, serverId)
    })
  })
  // Servers that gained or lost a tunnel to carry start or stop its connector too.
  await quietly(organizationId, () =>
    syncOrganizationTunnelConnectors(db, deps, organizationId, {
      maxServers: TUNNEL_NUDGE_MAX_SERVERS,
    })
  )
}

/** The organization an environment belongs to, or null when it is gone. */
export async function organizationOfEnvironment(
  db: Db,
  environmentId: string
): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: project.organizationId })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(eq(environment.id, environmentId))
    .limit(1)
  return row?.organizationId ?? null
}

/** Same as {@link nudgeTunnelRoutes}, for a change known only by its environment. */
export async function nudgeTunnelRoutesForEnvironment(
  db: Db,
  deps: TunnelSyncDeps | null,
  environmentId: string
): Promise<void> {
  if (!deps) return
  try {
    const organizationId = await organizationOfEnvironment(db, environmentId)
    if (organizationId) await nudgeTunnelRoutes(db, deps, organizationId)
  } catch (err) {
    compatLogWarn(
      'tunnel-sync',
      `environment ${environmentId}: ${err instanceof Error ? err.message : err}`
    )
  }
}
