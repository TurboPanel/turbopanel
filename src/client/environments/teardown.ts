/**
 * Host teardown for deleted environments.
 *
 * Deleting a project or an environment drops Postgres rows, but the host still
 * carries the deployment dir, hosting Caddy site, per-service tcp/udp Traefik
 * projects, `tpn_*` bridges, and per-service release trees
 * (`<principalHome>/sites/<serviceId>`) from the last deploy.
 * `environment.stop` is the only command that reclaims them, so delete plans it
 * **before** the rows go away (the payload is built from service / hosting /
 * steward / segment rows) and enqueues it **after** the delete commits.
 *
 * Reclaim is best effort: a never-deployed environment has no target server and
 * plans to `null`, and an unavailable queue must not block the delete.
 *
 * `siteReleases` comes from `resolveEnvironmentSiteReleases`, which unions the
 * trees the current compose declares with the ones the environment's `deployment`
 * rows recorded — so a Git-backed service that was removed from the compose
 * before the delete is still named here, rather than orphaned on the host.
 */
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import { environment, project } from '../../lib/db/schema.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  createCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import {
  composeNetworkNamesByServer,
  listEnvironmentComposeNetworks,
} from '../../lib/db/fabric-records.ts'
import { listEnvironmentDeploymentTargets } from '../../lib/db/deployment-records.ts'
import {
  parseProjectOptions,
  resolveEffectivePlacementServerId,
} from '../../lib/project-options.ts'
import { compatLogWarn } from '../../log-compat.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { retireHostingIngressIfIdle } from '../system/reconcile.ts'
import { composeProjectName } from './deploy-routes-helpers.ts'
import {
  type EnvironmentSiteRelease,
  resolveEnvironmentSiteReleases,
} from './site-releases.ts'
import { resolveTcpUdpIngressServices } from './tcp-udp-ingress.ts'

export type EnvironmentTeardownPlan = {
  environmentId: string
  projectId: string
  projectName: string
  /** Servers that carry (or would carry) this environment's stack. */
  serverIds: string[]
  ingressServices: Array<{ serviceId: string }>
  /** `tpn_*` compose bridge names to reclaim, per server. */
  fabricNetworksByServer: Map<string, string[]>
  /**
   * Release trees to reclaim. Generic — the same tree the Git release engine
   * publishes into and the native-runtime phase will run out of, so this is not
   * scoped to sites.
   */
  siteReleases: EnvironmentSiteRelease[]
}

/** Servers holding this environment's deployment, else its effective pin. */
async function resolveTeardownServerIds(
  db: Db,
  environmentId: string,
  environmentServerId: string | null,
  projectOptions: unknown,
): Promise<string[]> {
  const deployments = await listEnvironmentDeploymentTargets(db, environmentId)
  const fromDeployments = [
    ...new Set(deployments.map((row) => row.serverId)),
  ].sort((a, b) => a.localeCompare(b))
  if (fromDeployments.length > 0) return fromDeployments

  const pin = resolveEffectivePlacementServerId(
    environmentServerId,
    parseProjectOptions(projectOptions),
  )
  return pin ? [pin] : []
}

/**
 * Capture everything `environment.stop` needs while the rows still exist.
 * Returns `null` when the environment has no server to reclaim from (never
 * deployed and never pinned) — nothing to tear down.
 */
export async function planEnvironmentTeardown(
  db: Db,
  environmentId: string,
): Promise<EnvironmentTeardownPlan | null> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      serverId: environment.serverId,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!envRow) return null

  const [projectRow] = await db
    .select({ id: project.id, options: project.options })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return null

  const serverIds = await resolveTeardownServerIds(
    db,
    environmentId,
    envRow.serverId,
    projectRow.options,
  )
  if (serverIds.length === 0) return null

  const tcpUdpServices = await resolveTcpUdpIngressServices(db, environmentId)
  const composeNetworks = await listEnvironmentComposeNetworks(
    db,
    environmentId,
  )
  const siteReleases = await resolveEnvironmentSiteReleases(db, environmentId)

  return {
    environmentId,
    projectId: projectRow.id,
    projectName: composeProjectName(projectRow.id),
    serverIds,
    ingressServices: tcpUdpServices.map((svc) => ({ serviceId: svc.serviceId })),
    fabricNetworksByServer: composeNetworkNamesByServer(composeNetworks),
    siteReleases,
  }
}

/** Plan teardown for several environments, dropping the ones with no target. */
export async function planEnvironmentsTeardown(
  db: Db,
  environmentIds: readonly string[],
): Promise<EnvironmentTeardownPlan[]> {
  const plans: EnvironmentTeardownPlan[] = []
  for (const environmentId of environmentIds) {
    const plan = await planEnvironmentTeardown(db, environmentId)
    if (plan) plans.push(plan)
  }
  return plans
}

async function enqueueTeardownStop(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    serverId: string
    actorId: string
    plan: EnvironmentTeardownPlan
  }>,
): Promise<void> {
  const { plan, serverId } = params
  const fabricNetworks = plan.fabricNetworksByServer.get(serverId) ?? []
  const record = await createCommandRecord(db, {
    serverId,
    actorType: 'user',
    actorId: params.actorId,
    type: 'environment.stop',
    payload: {
      environmentId: plan.environmentId,
      projectId: plan.projectId,
      projectName: plan.projectName,
      ...(plan.ingressServices.length > 0
        ? { ingressServices: plan.ingressServices }
        : {}),
      ...(fabricNetworks.length > 0 ? { fabricNetworks } : {}),
      ...(plan.siteReleases.length > 0
        ? { siteReleases: plan.siteReleases }
        : {}),
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  })

  const envelope: CommandEnvelope = {
    commandId: record.id,
    serverId,
    type: 'environment.stop',
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }

  try {
    await commandQueue.enqueue(envelope)
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    throw new Error('Command queue unavailable')
  }
}

/**
 * Enqueue `environment.stop` for every planned server. Best effort: a failed
 * enqueue is logged (and compensated to `failed`) but never thrown — the rows
 * are already gone by the time this runs. Returns the servers reached, so the
 * caller can follow up with shared-ingress retirement.
 */
export async function dispatchEnvironmentTeardown(
  db: Db,
  commandQueue: CommandQueue,
  plans: readonly EnvironmentTeardownPlan[],
  actorId: string,
): Promise<string[]> {
  const reached = new Set<string>()
  for (const plan of plans) {
    const serverIds = new Set<string>([
      ...plan.serverIds,
      ...plan.fabricNetworksByServer.keys(),
    ])
    for (const serverId of serverIds) {
      try {
        await enqueueTeardownStop(db, commandQueue, {
          serverId,
          actorId,
          plan,
        })
        reached.add(serverId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        compatLogWarn(
          'environments',
          `environment.stop teardown enqueue failed for environment ${plan.environmentId} on server ${serverId}: ${message}`,
        )
      }
    }
  }
  return [...reached].sort((a, b) => a.localeCompare(b))
}

/**
 * Post-delete host reclaim: `environment.stop` per planned server, then retire
 * the shared HTTP Traefik on any server whose last hostname hosting just went
 * away. Entirely best effort — the rows are already gone, so missing dispatch
 * infrastructure or a rejected enqueue is logged, never surfaced as a delete
 * failure.
 */
export async function reclaimDeletedEnvironmentHosts(
  c: Context,
  db: Db,
  plans: readonly EnvironmentTeardownPlan[],
  actorId: string,
): Promise<void> {
  if (plans.length === 0) return

  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) {
    compatLogWarn(
      'environments',
      `host teardown skipped for ${plans.length} deleted environment(s): dispatch infrastructure unavailable`,
    )
    return
  }

  const serverIds = await dispatchEnvironmentTeardown(
    db,
    commandQueue,
    plans,
    actorId,
  )
  for (const serverId of serverIds) {
    await retireHostingIngressIfIdle(db, commandQueue, {
      serverId,
      actorType: 'user',
      actorId,
    })
  }
}
