/**
 * Starts a Let's Encrypt certificate without a full redeploy.
 *
 * The web server on each host learns a hosting's certificate choice from the
 * environment's deploy. Once a certificate is pinned, this queues the same
 * `environment.deploy` with `hostingsOnly: true`: the host rewrites the web
 * server config and certificates and leaves the apps alone (no build, no
 * restart), and the web server then asks Let's Encrypt for the certificate.
 *
 * It only queues when that is safe right now: the environment already runs a
 * finished deploy on every server, no deploy is in progress, every server is
 * online and its daemon lists `deploy-hostings-only-v1` (an older one would run
 * a full deploy), and nothing else in the environment changed since that
 * deploy finished (the run is built from the current settings and is recorded
 * as applied, so it must not carry edits nobody deployed). Otherwise nothing is
 * queued and the panel keeps telling the owner to redeploy, which is the
 * fallback. It never throws: a failure here must not
 * undo the certificate choice that was just saved.
 */
import { and, eq, gt, inArray, ne, or } from 'drizzle-orm'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import { environment, hosting, project, server, service } from '../../db/schema.ts'
import { isServerConnectedStoredOrLive } from '../../daemon/cell/server-status.ts'
import { isNoopCommandQueue } from '../../features/commands/noop-command-queue.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { listEnvironmentDeploymentTargets } from '../../features/deploy/deployment-records.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { DEPLOY_HOSTINGS_ONLY_FEATURE } from '../../lib/version-wire.ts'
import { getServerDaemonStateByServerId } from '../../features/servers/server-identity-db.ts'
import { type DeployActor, runEnvironmentDeployForActor } from '../environments/deploy-routes.ts'

export type HostingApplyOutcome =
  | 'queued'
  | 'queue_unavailable'
  | 'no_environment'
  | 'not_deployed'
  | 'deploy_in_progress'
  | 'server_offline'
  | 'daemon_too_old'
  | 'pending_changes'
  | 'refused'

export type HostingApplyDeps = {
  commandQueue: CommandQueue | null | undefined
  /** Live presence; the stored `is_connected` column answers without it. */
  registry?: DaemonCellRegistry
  runDeploy?: typeof runEnvironmentDeployForActor
  /** The wire features a server's daemon lists; defaults to its stored projection. */
  daemonFeatures?: (db: Db, serverId: string) => Promise<readonly string[]>
}

export type HostingApplyParams = {
  hostingId: string
  organizationId: string
  actor: DeployActor
  /** The hosting's `updatedAt` from before the certificate was pinned. */
  editedAt: string
}

async function storedDaemonFeatures(db: Db, serverId: string): Promise<readonly string[]> {
  const state = await getServerDaemonStateByServerId(db, serverId)
  return state?.projection?.features ?? []
}

const IN_PROGRESS_DEPLOYMENT_STATUSES: ReadonlySet<string> = new Set(['pending', 'applying'])

async function everyDaemonSupportsHostingsOnly(
  db: Db,
  serverIds: readonly string[],
  lookup: (db: Db, serverId: string) => Promise<readonly string[]>
): Promise<boolean> {
  const answers = await Promise.all(serverIds.map((id) => lookup(db, id)))
  return answers.every((features) => features.includes(DEPLOY_HOSTINGS_ONLY_FEATURE))
}

/**
 * Did anything a deploy carries change after `since`: the hosting itself
 * (before the pin), another hosting of the environment, one of its services,
 * the environment row or its project (the shared Base compose)?
 */
async function changedSince(
  db: Db,
  params: { environmentId: string; hostingId: string; editedAt: string; since: string }
): Promise<boolean> {
  if (Date.parse(params.editedAt) > Date.parse(params.since)) return true
  const [edited] = await db
    .select({ id: environment.id })
    .from(environment)
    .innerJoin(project, eq(project.id, environment.projectId))
    .where(
      and(
        eq(environment.id, params.environmentId),
        or(gt(environment.updatedAt, params.since), gt(project.updatedAt, params.since))
      )
    )
    .limit(1)
  if (edited) return true
  const [editedService] = await db
    .select({ id: service.id })
    .from(service)
    .where(
      and(eq(service.environmentId, params.environmentId), gt(service.updatedAt, params.since))
    )
    .limit(1)
  if (editedService) return true
  const [other] = await db
    .select({ id: hosting.id })
    .from(hosting)
    .innerJoin(service, eq(service.id, hosting.serviceId))
    .where(
      and(
        eq(service.environmentId, params.environmentId),
        ne(hosting.id, params.hostingId),
        gt(hosting.updatedAt, params.since)
      )
    )
    .limit(1)
  return other !== undefined
}

/** When the oldest of these finished deploys finished; `null` when one has no time. */
function oldestFinish(targets: readonly { finishedAt: string | null }[]): string | null {
  let oldest: string | null = null
  for (const target of targets) {
    if (target.finishedAt === null) return null
    if (oldest === null || Date.parse(target.finishedAt) < Date.parse(oldest)) {
      oldest = target.finishedAt
    }
  }
  return oldest
}

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
  params: HostingApplyParams,
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
  const since = oldestFinish(applied)
  if (applied.length === 0 || since === null) return 'not_deployed'
  const serverIds = applied.map((target) => target.serverId)
  if (!(await everyServerOnline(db, deps.registry, serverIds))) return 'server_offline'
  const features = deps.daemonFeatures ?? storedDaemonFeatures
  if (!(await everyDaemonSupportsHostingsOnly(db, serverIds, features))) return 'daemon_too_old'
  const changed = await changedSince(db, {
    environmentId,
    hostingId: params.hostingId,
    editedAt: params.editedAt,
    since,
  })
  if (changed) return 'pending_changes'
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
  params: HostingApplyParams,
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
