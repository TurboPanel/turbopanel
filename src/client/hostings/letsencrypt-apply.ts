/**
 * Starts a Let's Encrypt certificate without a full redeploy.
 *
 * The web server on each host learns a hosting's certificate choice from the
 * environment's deploy. Once a certificate is pinned, this queues the same
 * `environment.deploy` with `hostingsOnly: true`: the host rewrites the web
 * server config and certificates and leaves the apps alone (no build, no
 * restart), and the web server then asks Let's Encrypt for the certificate.
 *
 * It only queues when that can work right now: the environment already runs a
 * finished deploy on every server, no deploy is in progress, and every server
 * is online. Otherwise nothing is queued and the panel keeps telling the owner
 * to redeploy, which is the fallback. It never throws: a failure here must not
 * undo the certificate choice that was just saved.
 */
import { eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import { hosting, server, service } from '../../db/schema.ts'
import { isServerConnectedStoredOrLive } from '../../daemon/cell/server-status.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { listEnvironmentDeploymentTargets } from '../../features/deploy/deployment-records.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { type DeployActor, runEnvironmentDeployForActor } from '../environments/deploy-routes.ts'

export type HostingApplyOutcome =
  | 'queued'
  | 'queue_unavailable'
  | 'no_environment'
  | 'not_deployed'
  | 'deploy_in_progress'
  | 'server_offline'
  | 'refused'

export type HostingApplyDeps = {
  commandQueue: CommandQueue | null | undefined
  /** Live presence; the stored `is_connected` column answers without it. */
  registry?: DaemonCellRegistry
  runDeploy?: typeof runEnvironmentDeployForActor
}

const IN_PROGRESS_DEPLOYMENT_STATUSES: ReadonlySet<string> = new Set(['pending', 'applying'])

async function environmentOfHosting(db: Db, hostingId: string): Promise<string | null> {
  const [row] = await db
    .select({ environmentId: service.environmentId })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .where(eq(hosting.id, hostingId))
    .limit(1)
  return row?.environmentId ?? null
}

async function everyServerOnline(
  db: Db,
  registry: DaemonCellRegistry | undefined,
  serverIds: readonly string[]
): Promise<boolean> {
  const rows = await db
    .select({ id: server.id, isConnected: server.isConnected })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  if (rows.length !== serverIds.length) return false
  for (const row of rows) {
    if (!(await isServerConnectedStoredOrLive(db, registry, row.id, row.isConnected))) return false
  }
  return true
}

async function queueApply(
  c: Context<AppEnv>,
  db: Db,
  params: { hostingId: string; organizationId: string; actor: DeployActor },
  deps: HostingApplyDeps
): Promise<HostingApplyOutcome> {
  const commandQueue = deps.commandQueue
  if (!commandQueue || isNoopCommandQueue(commandQueue)) return 'queue_unavailable'
  const environmentId = await environmentOfHosting(db, params.hostingId)
  if (environmentId === null) return 'no_environment'
  const targets = await listEnvironmentDeploymentTargets(db, environmentId)
  if (targets.some((target) => IN_PROGRESS_DEPLOYMENT_STATUSES.has(target.status))) {
    return 'deploy_in_progress'
  }
  const applied = targets.filter((target) => target.status === 'applied')
  if (applied.length === 0) return 'not_deployed'
  if (
    !(await everyServerOnline(
      db,
      deps.registry,
      applied.map((target) => target.serverId)
    ))
  ) {
    return 'server_offline'
  }
  const runDeploy = deps.runDeploy ?? runEnvironmentDeployForActor
  const response = await runDeploy(c, db, commandQueue, environmentId, {
    ...params.actor,
    organizationId: params.organizationId,
    acknowledgeHealthCheckWarnings: true,
    noCache: false,
    selection: { ref: null, commitSha: null, sourceId: null },
    hostingsOnly: true,
  })
  if (response.ok) return 'queued'
  compatLogWarn(
    'hostings',
    `certificate apply for hosting ${params.hostingId} not queued: ${response.status} ${await response.text()}`
  )
  return 'refused'
}

export async function queueHostingCertificateApply(
  c: Context<AppEnv>,
  db: Db,
  params: { hostingId: string; organizationId: string; actor: DeployActor },
  deps: HostingApplyDeps
): Promise<HostingApplyOutcome> {
  try {
    return await queueApply(c, db, params, deps)
  } catch (err) {
    compatLogWarn(
      'hostings',
      `certificate apply for hosting ${params.hostingId} failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return 'refused'
  }
}
