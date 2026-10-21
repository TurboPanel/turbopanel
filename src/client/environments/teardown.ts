/**
 * Host teardown for deleted environments.
 *
 * Deleting a project or an environment drops Postgres rows, but the host still
 * carries the deployment dir, hosting Caddy site, per-service tcp/udp Traefik
 * projects, `tpn_*` bridges, and per-service release trees
 * (`<principalHome>/sites/<serviceId>`) from the last deploy.
 * `environment.stop` is the only command that reclaims them, so delete plans it
 * **before** the rows go away (the payload is built from service / hosting /
 * tenancy / subnet rows) and enqueues it **after** the delete commits.
 *
 * Reclaim is best effort: a never-deployed environment has no target server and
 * plans to `null`, and an unavailable queue must not block the delete.
 *
 * `siteReleases` comes from `resolveEnvironmentSiteReleases`, which unions the
 * trees the current compose declares with the ones the environment's `deployment`
 * rows recorded — so a Git-backed service that was removed from the compose
 * before the delete is still named here, rather than orphaned on the host.
 *
 * An environment delete captures the project's server principals too: once the
 * delete commits, any of them that no surviving environment still places on a
 * server is named in `retirePrincipals` on the last stop sent there, and the
 * daemon removes the account, its group, home and slice (`tp-host
 * principal-remove`, which re-checks on the host that nothing still references
 * it). A project delete does not (`keepPrincipals`): principals outlive their
 * project and are removed only by their own explicit delete.
 */
import { mapSequential, forEachSequential } from '../../lib/sequential.ts'
import { and, eq, inArray, or } from 'drizzle-orm'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import { deployment, environment, principal, project } from '../../db/schema.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { createCommandRecord, transitionCommand } from '../../features/commands/command-records.ts'
import {
  composeNetworkNamesByServer,
  listEnvironmentComposeNetworks,
} from '../../features/fabric/fabric-records.ts'
import { listEnvironmentDeploymentTargets } from '../../features/deploy/deployment-records.ts'
import { resolveEffectivePlacementServerId } from '../../features/projects/project-options.ts'
import { compatLogWarn } from '../../lib/log-compat.ts'
import { markPlacementsRetiring } from '../../features/principals/placement-records.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { retireHostingIngressIfIdle } from '../../features/system/reconcile.ts'
import { composeProjectName } from './deploy-routes-helpers.ts'
import { type EnvironmentSiteRelease, resolveEnvironmentSiteReleases } from './site-releases.ts'
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
  /**
   * The project's server principals (applied Linux logins). Candidates only:
   * which of them retire is decided after the delete commits, against the
   * environments that survive it ({@link resolvePrincipalRetirement}).
   */
  principalUsernames: string[]
}

export type TeardownPlanOptions = {
  /**
   * Leave the project's Linux users alone: plan no `retirePrincipals`. Project
   * delete sets this — the site trees go, the user and its home stay, and the
   * principal outlives the project (`principal.project_id` becomes NULL).
   */
  keepPrincipals?: boolean
}

/** Applied logins of the project's server (Linux) principals. */
async function loadProjectPrincipalUsernames(db: Db, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ username: principal.appliedUsername })
    .from(principal)
    .where(eq(principal.projectId, projectId))
  return [...new Set(rows.map((row) => row.username))].sort((a, b) => a.localeCompare(b))
}

/** Servers holding this environment's deployment, else its effective pin. */
async function resolveTeardownServerIds(
  db: Db,
  environmentId: string,
  environmentServerId: string | null,
  projectDefaultServerId: string | null
): Promise<string[]> {
  const deployments = await listEnvironmentDeploymentTargets(db, environmentId)
  const fromDeployments = [...new Set(deployments.map((row) => row.serverId))].sort((a, b) =>
    a.localeCompare(b)
  )
  if (fromDeployments.length > 0) return fromDeployments

  const pin = resolveEffectivePlacementServerId(environmentServerId, projectDefaultServerId)
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
  options: TeardownPlanOptions = {}
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
    .select({ id: project.id, defaultServerId: project.defaultServerId })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return null

  const serverIds = await resolveTeardownServerIds(
    db,
    environmentId,
    envRow.serverId,
    projectRow.defaultServerId
  )
  if (serverIds.length === 0) return null

  const tcpUdpServices = await resolveTcpUdpIngressServices(db, environmentId)
  const composeNetworks = await listEnvironmentComposeNetworks(db, environmentId)
  const siteReleases = await resolveEnvironmentSiteReleases(db, environmentId)
  const principalUsernames = options.keepPrincipals
    ? []
    : await loadProjectPrincipalUsernames(db, projectRow.id)

  return {
    environmentId,
    projectId: projectRow.id,
    projectName: composeProjectName(environmentId),
    serverIds,
    ingressServices: tcpUdpServices.map((svc) => ({ serviceId: svc.serviceId })),
    fabricNetworksByServer: composeNetworkNamesByServer(composeNetworks),
    siteReleases,
    principalUsernames,
  }
}

/** Plan teardown for several environments, dropping the ones with no target. */
export async function planEnvironmentsTeardown(
  db: Db,
  environmentIds: readonly string[],
  options: TeardownPlanOptions = {}
): Promise<EnvironmentTeardownPlan[]> {
  const planned = await mapSequential(environmentIds, (environmentId) =>
    planEnvironmentTeardown(db, environmentId, options)
  )
  return planned.filter((plan): plan is EnvironmentTeardownPlan => !!plan)
}

/** Servers one plan's stops go to: its targets plus fabric-only peers. */
function planServerIds(plan: EnvironmentTeardownPlan): Set<string> {
  return new Set<string>([...plan.serverIds, ...plan.fabricNetworksByServer.keys()])
}

/**
 * Of `usernames`, the ones a surviving environment still places on `serverId`:
 * a principal of a project with an environment pinned there or deployed there.
 * Run after the delete commits, so the deleted rows are no longer counted.
 */
export async function principalsStillOnServer(
  db: Db,
  serverId: string,
  usernames: readonly string[]
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ username: principal.appliedUsername })
    .from(principal)
    .innerJoin(environment, eq(environment.projectId, principal.projectId))
    .leftJoin(deployment, eq(deployment.environmentId, environment.id))
    .where(
      and(
        inArray(principal.appliedUsername, [...usernames]),
        or(eq(environment.serverId, serverId), eq(deployment.serverId, serverId))
      )
    )
  return new Set(rows.map((row) => row.username))
}

/**
 * Per server, the principals the deleted environments used there that nothing
 * surviving still places on it. Call after the delete has committed.
 */
export async function resolvePrincipalRetirement(
  db: Db,
  plans: readonly EnvironmentTeardownPlan[]
): Promise<Map<string, string[]>> {
  const candidates = new Map<string, Set<string>>()
  for (const plan of plans) {
    for (const serverId of plan.serverIds) {
      const set = candidates.get(serverId) ?? new Set<string>()
      for (const username of plan.principalUsernames) set.add(username)
      candidates.set(serverId, set)
    }
  }
  const retire = new Map<string, string[]>()
  await forEachSequential(candidates, async ([serverId, usernames]) => {
    if (usernames.size === 0) return
    const kept = await principalsStillOnServer(db, serverId, [...usernames])
    const gone = [...usernames]
      .filter((username) => !kept.has(username))
      .sort((a, b) => a.localeCompare(b))
    if (gone.length > 0) retire.set(serverId, gone)
  })
  return retire
}

/**
 * Bookkeeping only: the stop below is what retires the account, and it must go
 * out whether or not the placement row could be marked.
 */
async function markPlacementsRetiringBestEffort(
  db: Db,
  serverId: string,
  usernames: readonly string[]
): Promise<void> {
  if (usernames.length === 0) return
  try {
    await markPlacementsRetiring(db, serverId, usernames)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn(
      'environments',
      `placement retiring mark skipped on server ${serverId}: ${message}`
    )
  }
}

async function enqueueTeardownStop(
  db: Db,
  commandQueue: CommandQueue,
  params: Readonly<{
    serverId: string
    actorId: string
    plan: EnvironmentTeardownPlan
    retirePrincipals: readonly string[]
  }>
): Promise<void> {
  const { plan, serverId, retirePrincipals } = params
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
      ...(plan.ingressServices.length > 0 ? { ingressServices: plan.ingressServices } : {}),
      ...(fabricNetworks.length > 0 ? { fabricNetworks } : {}),
      ...(plan.siteReleases.length > 0 ? { siteReleases: plan.siteReleases } : {}),
      ...(retirePrincipals.length > 0
        ? { retirePrincipals: retirePrincipals.map((username) => ({ username })) }
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
  // Only once the stop is on its way: a row marked before a failed enqueue
  // would say `retiring` about an account nothing is retiring.
  await markPlacementsRetiringBestEffort(db, serverId, retirePrincipals)
}

/**
 * Enqueue `environment.stop` for every planned server. Best effort: a failed
 * enqueue is logged (and compensated to `failed`) but never thrown — the rows
 * are already gone by the time this runs. Returns the servers reached, so the
 * caller can follow up with shared-ingress retirement.
 *
 * `retireByServer` rides only on the **last** stop sent to each server, so the
 * account outlives every other environment's teardown there.
 */
export async function dispatchEnvironmentTeardown(
  db: Db,
  commandQueue: CommandQueue,
  plans: readonly EnvironmentTeardownPlan[],
  actorId: string,
  retireByServer: ReadonlyMap<string, readonly string[]> = new Map()
): Promise<string[]> {
  const lastPlanForServer = new Map<string, EnvironmentTeardownPlan>()
  for (const plan of plans) {
    for (const serverId of planServerIds(plan)) lastPlanForServer.set(serverId, plan)
  }
  const reached = new Set<string>()
  await forEachSequential(plans, async (plan) => {
    await forEachSequential(planServerIds(plan), async (serverId) => {
      const retirePrincipals =
        lastPlanForServer.get(serverId) === plan ? (retireByServer.get(serverId) ?? []) : []
      try {
        await enqueueTeardownStop(db, commandQueue, {
          serverId,
          actorId,
          plan,
          retirePrincipals,
        })
        reached.add(serverId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        compatLogWarn(
          'environments',
          `environment.stop teardown enqueue failed for environment ${plan.environmentId} on server ${serverId}: ${message}`
        )
      }
    })
  })
  return [...reached].sort((a, b) => a.localeCompare(b))
}

/** A failed lookup keeps every account: retiring one is never worth a guess. */
async function resolvePrincipalRetirementBestEffort(
  db: Db,
  plans: readonly EnvironmentTeardownPlan[]
): Promise<Map<string, string[]>> {
  try {
    return await resolvePrincipalRetirement(db, plans)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    compatLogWarn('environments', `principal retirement skipped: ${message}`)
    return new Map()
  }
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
  actorId: string
): Promise<void> {
  if (plans.length === 0) return

  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) {
    compatLogWarn(
      'environments',
      `host teardown skipped for ${plans.length} deleted environment(s): dispatch infrastructure unavailable`
    )
    return
  }

  const retireByServer = await resolvePrincipalRetirementBestEffort(db, plans)
  const serverIds = await dispatchEnvironmentTeardown(
    db,
    commandQueue,
    plans,
    actorId,
    retireByServer
  )
  await forEachSequential(serverIds, (serverId) =>
    retireHostingIngressIfIdle(db, commandQueue, {
      serverId,
      actorType: 'user',
      actorId,
    })
  )
}
