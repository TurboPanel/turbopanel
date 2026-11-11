/**
 * Project caches and helper reach, as one deploy prepare step.
 *
 * Decides, for one server, the complete cache set the deploy carries
 * (`caches`), which sites and apps get which cache's variables, which helper
 * containers publish a loopback port and to whom (`helperReach`), and the plain
 * variables each consumer gets. Refuses, with a sentence, what a daemon without
 * `project-cache-v1` cannot run. Nothing is read from a daemon that did not
 * list the feature: its fields are left absent, never sent empty.
 */

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { deployment, principal } from '../../db/schema.ts'
import type {
  EnvironmentDeployCache,
  EnvironmentDeployHelperReach,
  EnvironmentDeployHosting,
} from '../../contracts/commands/schemas.ts'
import { isSiteVariableName } from '../../features/hostings/hosting-options.ts'
import type { ResolvedVariableMap } from '../../features/variables/resolve-inherited.ts'
import type { Application } from '../../features/compose/ir.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { PROJECT_CACHE_FEATURE } from '../../lib/version-wire.ts'
import { cacheConsumers, cacheConsumerWarningMessage } from '../../features/caches/consumers.ts'
import { findCacheKeyConflicts } from '../../features/caches/conflicts.ts'
import {
  allocateHelperPorts,
  helperVariables,
  planHelperReach,
  readRecordedHelperPorts,
  type HelperPlanEntry,
  type ReachDecl,
  type ReachServiceInfo,
} from '../../features/caches/reach.ts'
import { listEnvironmentCaches, type CacheWithAccount } from '../../features/caches/store.ts'
import { applyCacheRows, cacheVariableNames } from '../../features/caches/variables.ts'
import { cacheWireSet } from '../../features/caches/wire.ts'
import {
  listReservedListenPorts,
  readRecordedListenPorts,
} from '../../features/deploy/deployment-records.ts'
import {
  loadPrincipalIdsByServiceIdForEnvironment,
  resolveServicePrincipalId,
  type ComposePrincipalResolution,
} from '../principals/tenancies.ts'
import { mapSequential } from '../../lib/sequential.ts'
import { effectiveAccountLimits } from './account-limits.ts'
import { storedDaemonFeatures } from './destroy-data.ts'

/** What reaches the variable resolvers: per origin service, its caches and plain helper variables. */
export type CacheDelivery = {
  rows: ReadonlyMap<string, CacheWithAccount>
  consumers: ReadonlyMap<string, readonly string[]>
  helperVars: ReadonlyMap<string, Readonly<Record<string, string>>>
}

export const EMPTY_CACHE_DELIVERY: CacheDelivery = {
  rows: new Map(),
  consumers: new Map(),
  helperVars: new Map(),
}

export type CacheOverrideWarning = { code: 'cache_variable_overrides'; key: string }

export type ProjectCacheRefusal = {
  kind: 'project_cache_refused'
  code: 'daemon_update_needed' | 'cache_key_conflict' | 'helper_reach_invalid'
  message: string
}

export type PreparedProjectCaches = {
  delivery: CacheDelivery
  /** Absent: leave the host's caches alone (an old daemon with none). */
  caches: EnvironmentDeployCache[] | undefined
  /** Absent: leave the host's reach list alone. */
  helperReach: EnvironmentDeployHelperReach[] | undefined
  /** Origin service to host port, recorded on the deployment so a redeploy keeps it. */
  helperPorts: Record<string, number>
  /** Origin service to the cache ids it gets, recorded for secret rehydrate. */
  cacheConsumers: Record<string, string[]>
  warnings: Array<{ code: string; message: string; details?: Record<string, unknown> }>
}

export const NO_PROJECT_CACHES: PreparedProjectCaches = {
  delivery: EMPTY_CACHE_DELIVERY,
  caches: undefined,
  helperReach: undefined,
  helperPorts: {},
  cacheConsumers: {},
  warnings: [],
}

const DAEMON_UPDATE_SENTENCE = 'Update the daemon on this server to use project caches'

type ServiceRowLike = { id: string; composeServiceName: string }

export type PrepareProjectCachesInput = {
  environmentId: string
  serverId: string
  secrets: DerivedSecretsConfig | undefined
  application: Application
  serviceRows: readonly ServiceRowLike[]
  principalResolution: ComposePrincipalResolution
  /** Services that run on this server; absent when the whole document does. */
  localServiceNames: ReadonlySet<string> | undefined
  /** Origin service name to its names after multi-instance expansion. */
  expansion?: ReadonlyMap<string, readonly string[]>
  orgOptions: unknown
  serverOptions: unknown
}

function reachDecls(application: Application): ReachDecl[] {
  const decls: ReachDecl[] = []
  for (const svc of application.services) {
    const reach = svc.turbopanel?.reach
    if (svc.kind === 'container' && reach) {
      decls.push({ service: svc.name, port: reach.port, from: reach.from })
    }
  }
  return decls
}

async function serviceAccounts(
  db: Db,
  input: PrepareProjectCachesInput
): Promise<Map<string, ReachServiceInfo>> {
  const assigned = await loadPrincipalIdsByServiceIdForEnvironment(db, input.environmentId)
  const idByName = new Map(input.serviceRows.map((row) => [row.composeServiceName, row.id]))
  const out = new Map<string, ReachServiceInfo>()
  for (const svc of input.application.services) {
    const alias = input.principalResolution.aliasByComposeServiceName.get(svc.name)
    const declared =
      alias === undefined
        ? undefined
        : { principalId: input.principalResolution.principalIdByAlias.get(alias) }
    const serviceId = idByName.get(svc.name)
    const ids = serviceId === undefined ? [] : (assigned.get(serviceId) ?? [])
    out.set(svc.name, { kind: svc.kind, principalId: resolveServicePrincipalId(ids, declared) })
  }
  return out
}

async function usernamesFor(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: principal.id, username: principal.appliedUsername })
    .from(principal)
    .where(inArray(principal.id, [...ids]))
  return new Map(rows.map((row) => [row.id, row.username]))
}

async function recordedDeploymentOptions(
  db: Db,
  environmentId: string,
  serverId: string
): Promise<unknown> {
  const [row] = await db
    .select({ options: deployment.options })
    .from(deployment)
    .where(and(eq(deployment.environmentId, environmentId), eq(deployment.serverId, serverId)))
    .limit(1)
  return row?.options
}

function refusal(code: ProjectCacheRefusal['code'], message: string): ProjectCacheRefusal {
  return { kind: 'project_cache_refused', code, message }
}

async function conflictRefusal(
  db: Db,
  environmentId: string,
  rows: readonly CacheWithAccount[]
): Promise<ProjectCacheRefusal | null> {
  const names = rows.flatMap((row) =>
    cacheVariableNames(row.keyPrefix, row.access === 'port' ? 'port' : 'socket')
  )
  const clash = await findCacheKeyConflicts(db, environmentId, names)
  if (clash.length === 0) return null
  return refusal(
    'cache_key_conflict',
    `A cache sets ${clash.join(', ')}, which a service or hostname variable also sets. Rename the variable or change the cache's variable prefix.`
  )
}

/** Everything the deploy needs from caches and helper reach for one server. */
export async function prepareProjectCaches(
  db: Db,
  input: PrepareProjectCachesInput
): Promise<PreparedProjectCaches | ProjectCacheRefusal> {
  const rows = await listEnvironmentCaches(db, input.environmentId)
  // A reach container is opened on the server that runs it, so others skip it.
  const decls = reachDecls(input.application).filter(
    (decl) => input.localServiceNames === undefined || input.localServiceNames.has(decl.service)
  )
  const features = await storedDaemonFeatures(db, input.serverId)
  const here = rows.filter((row) => row.serverId === input.serverId)
  if (!features.includes(PROJECT_CACHE_FEATURE)) {
    if (here.length > 0 || decls.length > 0) {
      return refusal('daemon_update_needed', DAEMON_UPDATE_SENTENCE)
    }
    return NO_PROJECT_CACHES
  }
  const accounts = await serviceAccounts(db, input)
  const local = [...accounts].filter(
    ([name]) => input.localServiceNames === undefined || input.localServiceNames.has(name)
  )
  const wired = cacheConsumers(
    local.map(([name, info]) => ({ name, kind: info.kind, principalId: info.principalId })),
    rows,
    input.serverId
  )
  const consumerRows = rows.filter((row) =>
    [...wired.consumers.values()].some((ids) => ids.includes(row.id))
  )
  const clash = await conflictRefusal(db, input.environmentId, consumerRows)
  if (clash) return clash

  const principalIds = [
    ...new Set([...accounts.values()].flatMap((info) => info.principalId ?? [])),
  ]
  const usernames = await usernamesFor(db, principalIds)
  const plan = planHelperReach(
    decls,
    accounts,
    (id) => usernames.get(id),
    input.expansion ?? new Map()
  )
  if (plan.errors.length > 0) {
    return refusal('helper_reach_invalid', plan.errors.join('. '))
  }
  const helper = await allocateForServer(db, input, plan.entries)
  const caches = await cacheWireSet(
    rows,
    input.serverId,
    input.secrets,
    effectiveAccountLimits(input.orgOptions, input.serverOptions)
  )
  return {
    delivery: {
      rows: new Map(rows.map((row) => [row.id, row])),
      consumers: wired.consumers,
      helperVars: helperVariables(plan.entries, helper.helperPorts),
    },
    caches,
    helperReach: helper.reach,
    helperPorts: helper.helperPorts,
    cacheConsumers: Object.fromEntries(wired.consumers),
    warnings: wired.warnings.map((warning) => ({
      code: warning.code,
      message: cacheConsumerWarningMessage(warning),
      details: { composeServiceName: warning.composeServiceName },
    })),
  }
}

async function allocateForServer(
  db: Db,
  input: PrepareProjectCachesInput,
  entries: readonly HelperPlanEntry[]
) {
  const reserved = await listReservedListenPorts(db, {
    environmentId: input.environmentId,
    serverIds: [input.serverId],
  })
  const used = new Set<number>(reserved.get(input.serverId))
  const options = await recordedDeploymentOptions(db, input.environmentId, input.serverId)
  const preferred = readRecordedHelperPorts(options)
  // Ports this environment's own sites and apps hold stay theirs; a helper's own earlier port is free to keep.
  const helperHeld = new Set(Object.values(preferred))
  for (const port of readRecordedListenPorts(options)) {
    if (!helperHeld.has(port)) used.add(port)
  }
  return allocateHelperPorts(entries, used, preferred, input.environmentId)
}

/** Rows of one service's caches, in the order the delivery lists them. */
export function deliveryRowsFor(
  delivery: CacheDelivery,
  composeServiceName: string
): CacheWithAccount[] {
  const ids = delivery.consumers.get(composeServiceName) ?? []
  return ids.flatMap((id) => delivery.rows.get(id) ?? [])
}

/**
 * Set one service's cache and helper entries on a resolved variable map, after
 * everything else. Overridden names come back as warnings (names only).
 */
export async function applyDeliveryToMap(
  secrets: DerivedSecretsConfig | undefined,
  delivery: CacheDelivery,
  composeServiceName: string,
  map: ResolvedVariableMap,
  warnings: Array<{ code: 'cache_variable_overrides'; key: string }>
): Promise<void> {
  await applyCacheRows(secrets, deliveryRowsFor(delivery, composeServiceName), map, warnings)
  const helper = delivery.helperVars.get(composeServiceName) ?? {}
  for (const [key, value] of Object.entries(helper)) {
    map.set(key, {
      value,
      isSecret: false,
      isLiteral: true,
      forBuild: false,
      forRuntime: true,
      bindingId: null,
    })
  }
}

/**
 * Add each hosting's cache and helper entries to its web environment. Run
 * before the secrets are resealed for the daemon: a secret still carries the
 * control plane's envelope here.
 */
export async function withCacheHostingEnv(
  hostings: readonly EnvironmentDeployHosting[],
  secrets: DerivedSecretsConfig | undefined,
  delivery: CacheDelivery,
  warnings: CacheOverrideWarning[] = []
): Promise<EnvironmentDeployHosting[]> {
  return await mapSequential(hostings, (entry) => {
    const name = entry.composeServiceName
    return name === undefined || !hasDelivery(delivery, name)
      ? entry
      : mergeDeliveryIntoHosting(entry, name, secrets, delivery, warnings)
  })
}

async function mergeDeliveryIntoHosting(
  entry: EnvironmentDeployHosting,
  name: string,
  secrets: DerivedSecretsConfig | undefined,
  delivery: CacheDelivery,
  warnings: CacheOverrideWarning[]
): Promise<EnvironmentDeployHosting> {
  const map: ResolvedVariableMap = new Map()
  await applyDeliveryToMap(secrets, delivery, name, map, [])
  const env: Record<string, string> = { ...entry.web?.env }
  const secretEnv: Record<string, string> = { ...entry.web?.secretEnv }
  for (const [key, item] of map) {
    if (!item.forRuntime || !isSiteVariableName(key)) continue
    // A cache name replaces the inherited one wherever it sits; a secret must not beat a plain value.
    if (key in env || key in secretEnv) warnings.push({ code: 'cache_variable_overrides', key })
    delete env[key]
    delete secretEnv[key]
    if (item.isSecret) secretEnv[key] = item.value
    else env[key] = item.value
  }
  return {
    ...entry,
    web: {
      ...entry.web,
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(Object.keys(secretEnv).length > 0 ? { secretEnv } : {}),
    },
  }
}

function hasDelivery(delivery: CacheDelivery, name: string): boolean {
  return delivery.consumers.has(name) || delivery.helperVars.has(name)
}

/**
 * Turn the PHP `redis` extension on for the sites that get a cache. A site with
 * no PHP block is not a PHP site, so it is left as it is.
 */
export function withRedisExtension<
  T extends { composeServiceName: string; php?: { extensions?: string[] } },
>(sites: readonly T[], delivery: CacheDelivery): T[] {
  return sites.map((site) => {
    const consumes = (delivery.consumers.get(site.composeServiceName)?.length ?? 0) > 0
    if (!consumes || site.php === undefined) return site
    const extensions = [...new Set([...(site.php.extensions ?? []), 'redis'])].toSorted((a, b) =>
      a.localeCompare(b)
    )
    return { ...site, php: { ...site.php, extensions } }
  })
}
