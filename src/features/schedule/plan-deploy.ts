/**
 * Load fleet + compose, interpret Swarm `deploy:`, and plan slots.
 */

import { and, eq, inArray, sql } from 'drizzle-orm'
import { isComposeChainError, resolveComposeLayerChain } from '../compose/layer-chain.ts'
import type { Db } from '../../db/connection.ts'
import {
  environment,
  fabric,
  organization,
  storageCopy,
  mount,
  project,
  server,
  service,
  storage,
} from '../../db/schema.ts'
import { recordAudit } from '../audit/audit-records.ts'
import { listServerLabelsForServers } from '../servers/label-records.ts'
import { type HostAccessAuditEvent, hostAccessAuditEntry } from './host-access-audit.ts'
import { listEnvironmentSlots } from '../servers/slot-records.ts'
import {
  type ComposeDeployValidationError,
  type ComposeDocument,
  hostAccessFingerprint,
  findNetworkShareVolumes,
  hostAccessIssues,
  mergeComposeLayers,
  networkSharesFingerprint,
  validateComposeForDeploy,
} from '../compose/index.ts'
import {
  parseOrganizationOptions,
  resolveComposeGatedFieldsEnabled,
  resolveComposeRemoteBuildSourcesEnabled,
} from '../organizations/organization-options.ts'
import { parseServerOptions } from '../servers/server-metadata.ts'
import { parseServiceOptions, resolveServiceInstances } from '../projects/service-options.ts'
import { environmentComposeFilename } from '../deploy/deploy-layers.ts'
import { interpretServiceSchedule } from './interpret.ts'
import { reconcileServicesFromCompose } from '../deploy/reconcile-services.ts'
import { registerComposeVolumes } from '../deploy/register-compose-volumes.ts'
import { registerComposeMounts } from '../deploy/register-compose-mounts.ts'
import type {
  ComposeBaseRecord,
  DeployProjectOptions,
  TrackedBaseError,
} from '../projects/project-options.ts'
import { loadPairRules } from '../fabric/pair-rules.ts'
import { readOverlayDeclaredNetworkKeys } from '../fabric/spanning.ts'
import {
  planEnvironmentSchedule,
  type FleetServer,
  type PlannedService,
  type SchedulePlan,
} from './planner.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Who is asking for this deploy, as far as host-level Compose features care.
 * Resolved by the caller, which has the session or knows the trigger — this
 * module never evaluates grants itself.
 *
 * - `manager` — a person holding `organization:manage` (owner, manager, or a
 *   platform admin). When `recordApproval` is set, a successful gate records
 *   the document's host-level fingerprint as approved for automated deploys
 *   (and a `compose.host_access.approve` audit row, stamped with `email`);
 *   a preview leaves it off because it changes nothing.
 * - `not_manager` — a person without that grant.
 * - `automated` — no person: a git push, or a run the control plane starts
 *   itself (applying a hosting's new certificate).
 */
export type HostAccessActor =
  | { kind: 'manager'; userId: string; email?: string | null; recordApproval: boolean }
  | { kind: 'not_manager' }
  | { kind: 'automated' }

/** Where an approved host-level fingerprint lives on `environment.metadata`. */
export const HOST_ACCESS_APPROVAL_METADATA_KEY = 'composeHostAccessApproval'

type HostAccessApproval = {
  fingerprint: string
  approvedBy: string
  approvedAt: string
}

function readHostAccessApproval(metadata: unknown): HostAccessApproval | null {
  if (!isPlainObject(metadata)) return null
  const raw = metadata[HOST_ACCESS_APPROVAL_METADATA_KEY]
  if (!isPlainObject(raw) || typeof raw.fingerprint !== 'string') return null
  return {
    fingerprint: raw.fingerprint,
    approvedBy: typeof raw.approvedBy === 'string' ? raw.approvedBy : '',
    approvedAt: typeof raw.approvedAt === 'string' ? raw.approvedAt : '',
  }
}

/**
 * The actor half of the host-level gate. Runs only after
 * `validateComposeForDeploy` has passed, i.e. the organization has host-level
 * features on (or the document reaches nothing on the host).
 *
 * `hostLevelApproved` is true exactly when the document reaches the host and
 * the actor may use that: the daemon's own confinement reads it off the
 * `environment.deploy` payload.
 */
async function authorizeHostAccess(
  db: Db,
  envRow: { id: string; projectId: string; metadata: unknown },
  organizationId: string,
  merged: ComposeDocument,
  actor: HostAccessActor,
  record: typeof recordAudit
): Promise<
  | { error: ComposeDeployValidationError }
  | { hostLevelApproved: boolean; hostAccessUse?: HostAccessAuditEvent }
> {
  const fingerprint = await hostAccessFingerprint(merged.data)
  if (fingerprint === null) return { hostLevelApproved: false }
  const issues = hostAccessIssues(merged.data)
  if (actor.kind === 'not_manager') {
    return { error: { kind: 'compose_host_access_requires_manager', issues } }
  }
  const approved = readHostAccessApproval(envRow.metadata)
  if (actor.kind === 'automated') {
    // The use row is written by the route once the deploy is persisted, so a
    // deploy refused further on leaves no claim that it ran.
    return approved?.fingerprint === fingerprint
      ? {
          hostLevelApproved: true,
          hostAccessUse: {
            action: 'compose.host_access.use',
            fingerprint,
            issues,
            approvedBy: approved.approvedBy,
            approvedAt: approved.approvedAt,
          },
        }
      : { error: { kind: 'compose_host_access_requires_approval', issues } }
  }
  if (actor.recordApproval && approved?.fingerprint !== fingerprint) {
    const approval: HostAccessApproval = {
      fingerprint,
      approvedBy: actor.userId,
      approvedAt: new Date().toISOString(),
    }
    // Merged into the existing jsonb rather than replacing it, so a concurrent
    // metadata edit is not lost. The key is stripped from client input
    // (`ENVIRONMENT_PROMOTED_METADATA_KEYS`), so only this write sets it.
    await db
      .update(environment)
      .set({
        metadata: sql`coalesce(${environment.metadata}, '{}'::jsonb) || jsonb_build_object(${HOST_ACCESS_APPROVAL_METADATA_KEY}::text, ${JSON.stringify(approval)}::jsonb)`,
      })
      .where(eq(environment.id, envRow.id))
    // Only after the approval write succeeded; `recordAudit` never throws.
    await record(
      db,
      hostAccessAuditEntry(
        { action: 'compose.host_access.approve', issues, ...approval },
        { organizationId, environmentId: envRow.id, projectId: envRow.projectId },
        { userId: actor.userId, email: actor.email ?? null }
      )
    )
  }
  return { hostLevelApproved: true }
}

/** Where an approved network-share fingerprint lives on `environment.metadata`. */
export const NETWORK_SHARES_APPROVAL_METADATA_KEY = 'composeNetworkSharesApproval'

/**
 * The permission to deploy a network share. A catalog permission on the
 * organization: the owner and manager (and a platform admin) hold it without a
 * grant row, and it can be granted to any other role like any other permission.
 */
export const NETWORK_SHARES_PERMISSION = 'environments.deploy_network_shares'

/**
 * Who is deploying, for the network-share gate. Decided by the caller from the
 * permission above, so this module never reads a role. `automated` is a push or
 * a run the control plane starts: no person, judged on a recorded approval.
 */
export type NetworkSharesActor =
  | { kind: 'permitted'; userId: string; email?: string | null }
  | { kind: 'denied' }
  | { kind: 'automated' }

export type NetworkSharesApproval = {
  /** Hash of the authored share volumes (unresolved text). */
  fingerprint: string
  /**
   * Hashes of what the shares resolved to (addresses, options, which secret
   * fills which field) in the deploys a permitted person ran. A variable that
   * changes the mount changes the hash, so an automated deploy cannot run on it.
   */
  resolved: string[]
  approvedBy: string
  approvedAt: string
}

/** Resolved-share hashes kept on one approval; the oldest drop first. */
const MAX_APPROVED_RESOLVED = 32

function readNetworkSharesApproval(metadata: unknown): NetworkSharesApproval | null {
  if (!isPlainObject(metadata)) return null
  const raw = metadata[NETWORK_SHARES_APPROVAL_METADATA_KEY]
  if (!isPlainObject(raw) || typeof raw.fingerprint !== 'string') return null
  return {
    fingerprint: raw.fingerprint,
    resolved: Array.isArray(raw.resolved)
      ? raw.resolved.filter((hash): hash is string => typeof hash === 'string')
      : [],
    approvedBy: typeof raw.approvedBy === 'string' ? raw.approvedBy : '',
    approvedAt: typeof raw.approvedAt === 'string' ? raw.approvedAt : '',
  }
}

/** What the planner decided about the document's network shares. */
export type NetworkSharesPlan = {
  volumes: string[]
  fingerprint: string
  actor: NetworkSharesActor
  /** The approval stored on the environment when planning started. */
  approval: NetworkSharesApproval | null
  /** The newest "Allow Network Shares turned on" time among the plan's servers. */
  newestEnabledAt: string | null
}

/**
 * The actor half of the network-share gate: the deploying user's permission.
 * (The server half runs once the plan knows its servers; see
 * {@link checkNetworkShareServers}.) Both halves must pass. This step writes
 * nothing; a permitted person's approval is recorded by
 * {@link settleNetworkShares} once the deploy has been prepared, because what
 * the shares resolve to is only known then.
 *
 * - a person without the permission is refused (`permission`);
 * - an automated deploy runs only on an approval a permitted person recorded
 *   for this exact set of shares (`approval`), the same rule as host-level
 *   Compose.
 */
async function authorizeNetworkShares(
  envRow: { metadata: unknown },
  merged: ComposeDocument,
  actor: NetworkSharesActor
): Promise<{ error: ComposeDeployValidationError } | { shares: NetworkSharesPlan | null }> {
  const volumes = findNetworkShareVolumes(merged.data)
  if (volumes.length === 0) return { shares: null }
  if (actor.kind === 'denied') {
    return { error: { kind: 'compose_network_shares_refused', reason: 'permission', volumes } }
  }
  const fingerprint = (await networkSharesFingerprint(merged.data)) ?? ''
  const approval = readNetworkSharesApproval(envRow.metadata)
  if (actor.kind === 'automated' && approval?.fingerprint !== fingerprint) {
    return { error: { kind: 'compose_network_shares_refused', reason: 'approval', volumes } }
  }
  return { shares: { volumes, fingerprint, actor, approval, newestEnabledAt: null } }
}

function isNewerThan(later: string | null | undefined, than: string): boolean {
  if (!later) return false
  const a = Date.parse(later)
  const b = Date.parse(than)
  return Number.isNaN(b) ? true : !Number.isNaN(a) && a > b
}

/**
 * The server half of the network-share gate, over the servers the plan will
 * dispatch to. The setting is `server.options.networkShares`; absent or
 * anything but `true` reads as off. An automated deploy also needs its approval
 * to be newer than the moment the setting was last turned on, so switching it
 * off and on again voids earlier approvals until a permitted person deploys.
 */
async function checkNetworkShareServers(
  db: Db,
  serverIds: readonly string[],
  shares: NetworkSharesPlan
): Promise<ComposeDeployValidationError | { newestEnabledAt: string | null }> {
  if (serverIds.length === 0) return { newestEnabledAt: null }
  const rows = await db
    .select({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      options: server.options,
    })
    .from(server)
    .where(inArray(server.id, [...serverIds]))
  const parsed = rows.map((row) => ({ row, options: parseServerOptions(row.options) }))
  const off = parsed
    .filter(({ options }) => options?.networkShares !== true)
    .map(({ row }) => ({ id: row.id, name: row.name ?? row.hostname ?? row.id }))
  if (off.length > 0) {
    return {
      kind: 'compose_network_shares_refused',
      reason: 'server_setting',
      volumes: shares.volumes,
      servers: off,
    }
  }
  let newestEnabledAt: string | null = null
  const reenabled: Array<{ id: string; name: string }> = []
  for (const { row, options } of parsed) {
    const since = options?.networkSharesSince
    if (since === undefined) continue
    if (newestEnabledAt === null || isNewerThan(since, newestEnabledAt)) newestEnabledAt = since
    if (
      shares.actor.kind === 'automated' &&
      isNewerThan(since, shares.approval?.approvedAt ?? '')
    ) {
      reenabled.push({ id: row.id, name: row.name ?? row.hostname ?? row.id })
    }
  }
  if (reenabled.length > 0) {
    return {
      kind: 'compose_network_shares_refused',
      reason: 'approval',
      volumes: shares.volumes,
      servers: reenabled,
    }
  }
  return { newestEnabledAt }
}

/** A matched approval an automated deploy ran under; the route writes it as `compose.network_shares.use`. */
export type NetworkSharesUseEvent = {
  fingerprint: string
  volumes: string[]
  resolved: string[]
  approvedBy: string
  approvedAt: string
}

/**
 * The second half of the actor gate, once the deploy is prepared and what the
 * shares resolve to is known (`resolved`: one hash per server's answer).
 *
 * - an automated deploy needs every hash on its approval, else `approval`:
 *   a variable that changed the address or the options is not what a permitted
 *   person approved;
 * - a permitted person's real deploy (`record`) writes the approval (and an
 *   audit row) when the shares, what they resolve to, or the server setting
 *   moved since the last one. The approval is merged into the environment's
 *   jsonb, so a concurrent metadata edit is kept.
 */
export async function settleNetworkShares(
  db: Db,
  input: {
    shares: NetworkSharesPlan
    organizationId: string
    environmentId: string
    projectId: string
    resolved: readonly string[]
    /** False for a preview or a hostings-only run, which approve nothing. */
    record: boolean
  },
  recordAuditRow: typeof recordAudit = recordAudit
): Promise<{ error: ComposeDeployValidationError } | { use?: NetworkSharesUseEvent }> {
  const { shares } = input
  const hashes = [...new Set(input.resolved)]
  const known = new Set(shares.approval?.resolved ?? [])
  if (shares.actor.kind === 'automated') {
    if (shares.approval === null || hashes.some((hash) => !known.has(hash))) {
      return {
        error: {
          kind: 'compose_network_shares_refused',
          reason: 'approval',
          volumes: shares.volumes,
        },
      }
    }
    return {
      use: {
        fingerprint: shares.fingerprint,
        volumes: shares.volumes,
        resolved: hashes,
        approvedBy: shares.approval.approvedBy,
        approvedAt: shares.approval.approvedAt,
      },
    }
  }
  if (shares.actor.kind !== 'permitted' || !input.record) return {}
  const { approval } = shares
  const voided =
    approval !== null &&
    shares.newestEnabledAt !== null &&
    isNewerThan(shares.newestEnabledAt, approval.approvedAt)
  const sameShares = approval !== null && approval.fingerprint === shares.fingerprint && !voided
  if (sameShares && hashes.every((hash) => known.has(hash))) return {}
  const next: NetworkSharesApproval = {
    fingerprint: shares.fingerprint,
    resolved: [...(sameShares ? approval.resolved : []), ...hashes]
      .filter((hash, index, all) => all.indexOf(hash) === index)
      .slice(-MAX_APPROVED_RESOLVED),
    approvedBy: shares.actor.userId,
    approvedAt: new Date().toISOString(),
  }
  await db
    .update(environment)
    .set({
      metadata: sql`coalesce(${environment.metadata}, '{}'::jsonb) || jsonb_build_object(${NETWORK_SHARES_APPROVAL_METADATA_KEY}::text, ${JSON.stringify(next)}::jsonb)`,
    })
    .where(eq(environment.id, input.environmentId))
  await recordAuditRow(db, {
    organizationId: input.organizationId,
    actorUserId: shares.actor.userId,
    actorEmail: shares.actor.email ?? null,
    action: 'compose.network_shares.approve',
    targetType: 'environment',
    targetId: input.environmentId,
    context: {
      environmentId: input.environmentId,
      projectId: input.projectId,
      fingerprint: next.fingerprint,
      volumes: shares.volumes,
      resolved: hashes,
      approvedBy: next.approvedBy,
      approvedAt: next.approvedAt,
    },
  })
  return {}
}

export type PlannedDeploy = {
  plan: SchedulePlan
  /**
   * The merged document passed deploy-time compose validation
   * (`lib/compose/validate-for-deploy.ts`) **before** this plan reconciled a
   * single row.
   *
   * Carried rather than implied so the per-server prepare can see that the
   * document it is about to compile has already been through stages 1–4 for
   * this request, and skip re-running them over the identical merge. The gate
   * itself is not optional — see {@link planEnvironmentDeploy}.
   */
  composeValidated: true
  /**
   * The merged document reaches the host and this actor may deploy it: the
   * organization has host-level Compose features on and a manager or owner
   * deployed it (or an automated deploy matches the recorded approval).
   * Rides every `environment.deploy` command of this deploy as
   * `hostLevelApproved`, which is what lets the daemon allow absolute and
   * Docker-socket binds.
   */
  hostLevelApproved: boolean
  /**
   * Set when an automated deploy passed the host-level gate on a recorded
   * approval: the route writes it as a `compose.host_access.use` audit row once
   * the deploy is persisted, unless the run is hostings-only (Compose is not
   * brought up, so nothing is used). Absent for people and for documents that
   * reach nothing on the host.
   */
  hostAccessUse?: HostAccessAuditEvent
  /**
   * The organization allows builds to fetch a public remote source. Rides every
   * `environment.deploy` command as `remoteBuildSourcesApproved`, so the daemon
   * repeats the same verdict instead of refusing what the control plane let by.
   */
  remoteBuildSourcesApproved: boolean
  /**
   * The document mounts a network share and both halves of the gate passed (the
   * actor may deploy shares and every server the plan uses allows them). Rides
   * every `environment.deploy` command as `allowNetworkShares`; false when the
   * document has no share or the plan failed.
   */
  allowNetworkShares: boolean
  /**
   * The share half of the actor gate, still to be settled once the deploy is
   * prepared ({@link settleNetworkShares}). Absent when the document has no
   * network share.
   */
  networkShares?: NetworkSharesPlan
  pinServerId: string | null
  defaultServerId: string | null
  fabricEnabled: boolean
  fabricId: string | null
  merged: ComposeDocument
  serviceRows: Array<{ id: string; composeServiceName: string; options: unknown }>
  projectId: string
  /** The project options the plan merged: the tracked Base is already swapped in. */
  projectOptions: unknown
  /** The Base this deploy used when the project follows a repository file; else `null`. */
  composeBase: ComposeBaseRecord | null
  /** Commit the tracked read resolved from a branch head, to pin the matching builds to. */
  composeBasePin?: { sourceId: string; ref: string; commitSha: string }
  /** Set by a preview that fell back to the stored Base because the file could not be read. */
  composeBaseUnreadable?: TrackedBaseError
  /** A fresh read of the tracked file, to store once the deploy is accepted. */
  composeBaseRead?: { document: unknown; record: ComposeBaseRecord }
}

/** Swaps in the tracked Base for a project that follows its repository's compose file. */
export type ResolveProjectOptions = (row: {
  id: string
  options: unknown
  environmentId: string
  environmentOptions: unknown
}) => Promise<DeployProjectOptions>

export type PlanDeployError =
  | { kind: 'not_found' }
  | { kind: 'invalid_compose' }
  /** The project follows its repository's compose file and that file could not be used. */
  | { kind: 'tracked_base_failed'; error: TrackedBaseError }
  /**
   * The merged document is a document TurboPanel will refuse to deploy.
   *
   * Carries the refusal itself rather than collapsing to `invalid_compose`, so
   * the route answers with the same body the per-server prepare would have —
   * the operator should not get a different diagnosis depending on which stage
   * of the deploy happened to notice.
   */
  | { kind: 'compose_rejected'; error: ComposeDeployValidationError }

/**
 * Optional doubles for host-free tests. Production callers omit this; defaults
 * are the real reconcile / register / task / label helpers.
 */
export type PlanEnvironmentDeployDeps = {
  reconcileServicesFromCompose?: typeof reconcileServicesFromCompose
  registerComposeVolumes?: typeof registerComposeVolumes
  registerComposeMounts?: typeof registerComposeMounts
  listEnvironmentSlots?: typeof listEnvironmentSlots
  listServerLabelsForServers?: typeof listServerLabelsForServers
  recordAudit?: typeof recordAudit
}

/** Host-free: pull `options.compose` (or null) from project/environment options. */
export function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null
  return options.compose ?? null
}

/** Host-free: merge project + environment compose layers, or `invalid_compose`. */
export function resolveMergedCompose(
  projectOptions: unknown,
  environmentOptions: unknown,
  environmentFilename: string
): ComposeDocument | PlanDeployError {
  const chain = resolveComposeLayerChain({
    projectOptions,
    environmentOptions,
    environmentFilename,
  })
  if (isComposeChainError(chain)) return chain
  try {
    return mergeComposeLayers(chain)
  } catch {
    return { kind: 'invalid_compose' }
  }
}

/** Host-free: `document.data.services` as a mapping, else `{}`. */
export function servicesMapping(document: ComposeDocument): Record<string, unknown> {
  const services = document.data.services
  return isPlainObject(services) ? services : {}
}

export type StoragePinMountRow = {
  serviceId: string
  storageId: string
  locationServerId: string | null
  locationRole: string | null
}

/**
 * Host-free: pin each service to its storage primary server unless the volume
 * has a shared (null-server) storageCopy.
 */
export function computeStoragePinsFromMountRows(
  rows: readonly StoragePinMountRow[]
): Map<string, string> {
  const hasShared = new Set<string>()
  const primaryServer = new Map<string, string>()
  for (const row of rows) {
    if (row.locationServerId === null) hasShared.add(row.storageId)
    if (row.locationRole === 'primary' && row.locationServerId) {
      primaryServer.set(row.storageId, row.locationServerId)
    }
  }

  const pins = new Map<string, string>()
  for (const row of rows) {
    if (pins.has(row.serviceId) || hasShared.has(row.storageId)) continue
    const serverId = primaryServer.get(row.storageId)
    if (!serverId) continue
    pins.set(row.serviceId, serverId)
  }
  return pins
}

async function loadFleet(
  db: Db,
  organizationId: string,
  listLabels: typeof listServerLabelsForServers
): Promise<FleetServer[]> {
  const rows = await db
    .select({
      id: server.id,
      connected: server.isConnected,
      name: server.name,
      hostname: server.hostname,
      fabricEnabled: server.isFabricEnabled,
    })
    .from(server)
    .where(eq(server.organizationId, organizationId))

  const labelsByServer = await listLabels(
    db,
    rows.map((row) => row.id)
  )
  return rows.map((row) => {
    const labels: Record<string, string> = {}
    for (const label of labelsByServer.get(row.id) ?? []) {
      labels[label.key] = label.value
    }
    return {
      id: row.id,
      connected: row.connected,
      labels,
      name: row.name ?? row.hostname ?? row.id,
      fabricEnabled: row.fabricEnabled,
    }
  })
}

export async function loadStoragePins(
  db: Db,
  organizationId: string,
  environmentId: string
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      serviceId: mount.serviceId,
      storageId: storage.id,
      locationServerId: storageCopy.serverId,
      locationRole: storageCopy.role,
    })
    .from(mount)
    .innerJoin(storage, eq(mount.storageId, storage.id))
    .innerJoin(storageCopy, eq(storageCopy.storageId, storage.id))
    .where(
      and(eq(storage.organizationId, organizationId), eq(storage.environmentId, environmentId))
    )

  return computeStoragePinsFromMountRows(rows)
}

type PlanContext = {
  envRow: {
    id: string
    projectId: string
    serverId: string | null
    options: unknown
    metadata: unknown
    name: string
  }
  projectRow: { id: string; options: unknown; defaultServerId: string | null }
  resolvedOptions: Extract<DeployProjectOptions, { ok: true }>
  merged: ComposeDocument
}

/**
 * Read the environment and project rows, swap in the tracked Base when the
 * project follows its repository, and merge the compose layers.
 */
async function loadPlanContext(
  db: Db,
  params: {
    environmentId: string
    resolveProjectOptions?: ResolveProjectOptions
  }
): Promise<PlanContext | PlanDeployError> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      serverId: environment.serverId,
      options: environment.options,
      metadata: environment.metadata,
      name: environment.name,
    })
    .from(environment)
    .where(eq(environment.id, params.environmentId))
    .limit(1)
  if (!envRow) return { kind: 'not_found' }

  const [projectRow] = await db
    .select({
      id: project.id,
      options: project.options,
      defaultServerId: project.defaultServerId,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) return { kind: 'not_found' }

  const filename = environmentComposeFilename({ id: envRow.id, name: envRow.name })
  const resolvedOptions: DeployProjectOptions = params.resolveProjectOptions
    ? await params.resolveProjectOptions({
        id: projectRow.id,
        options: projectRow.options,
        environmentId: envRow.id,
        environmentOptions: envRow.options,
      })
    : { ok: true, options: projectRow.options, base: null }
  if (!resolvedOptions.ok) return { kind: 'tracked_base_failed', error: resolvedOptions.error }
  const merged = resolveMergedCompose(resolvedOptions.options, envRow.options, filename)
  if ('kind' in merged) return merged
  return { envRow, projectRow, resolvedOptions, merged }
}

/** The schedule spec of each service row, read from the merged document. */
function plannedServicesFromRows(
  serviceRows: ReadonlyArray<{
    id: string
    composeServiceName: string
    options: unknown
  }>,
  merged: ComposeDocument
): PlannedService[] {
  const mapping = servicesMapping(merged)
  return serviceRows.map((row) => {
    const raw = mapping[row.composeServiceName]
    const body = isPlainObject(raw) ? raw : {}
    const fallback = resolveServiceInstances(parseServiceOptions(row.options) ?? {})
    return {
      serviceId: row.id,
      spec: interpretServiceSchedule(row.composeServiceName, body, fallback),
    }
  })
}

/** Pair rules for the planner, read only when more than one server and an overlay network could span. */
async function loadPairRulesIfSpanning(
  db: Db,
  organizationId: string,
  fleet: ReadonlyArray<{ id: string }>,
  merged: ComposeDocument
): Promise<Awaited<ReturnType<typeof loadPairRules>> | null> {
  if (fleet.length <= 1 || readOverlayDeclaredNetworkKeys(merged).size === 0) return null
  return await loadPairRules(db, { organizationId, serverIds: fleet.map((row) => row.id) })
}

/**
 * The server half of the network share gate, over exactly the servers the plan
 * dispatches to. Nothing to check without shares or without a plan.
 */
async function checkSharesOnPlannedServers(
  db: Db,
  plan: ReturnType<typeof planEnvironmentSchedule>,
  shares: NetworkSharesPlan | null
): Promise<{ shares: NetworkSharesPlan | null } | PlanDeployError> {
  if (shares === null || !plan.ok) return { shares }
  const checked = await checkNetworkShareServers(db, plan.serverIds, shares)
  if ('kind' in checked) return { kind: 'compose_rejected', error: checked }
  return { shares: { ...shares, newestEnabledAt: checked.newestEnabledAt } }
}

/**
 * Plan slots for an environment deploy. Callers map `SchedulePlan` errors to
 * HTTP (`turbofabric_required` → 422, no eligible server → 409). The merged
 * document rides into the planner because `turbofabric_required` is a verdict
 * about the document's `driver: overlay` networks, not about how many servers
 * the plan happened to use.
 *
 * **Validation comes before scheduling.** The merged document is run through
 * `validateComposeForDeploy` (schema → extension → semantic → policy) as the
 * first thing after the merge, and a refusal returns `compose_rejected` without
 * touching a row. Everything after that point writes: `reconcileServicesFromCompose`
 * creates and retires `service` rows, `registerComposeVolumes` /
 * `registerComposeMounts` create `storage` and `mount` rows. A deploy that is
 * going to be refused must not reshape the control plane first, and the refusal
 * used to arrive only later, in the per-server prepare.
 *
 * Optional {@link PlanEnvironmentDeployDeps} lets host-free tests stub
 * reconcile / register / list helpers without Postgres.
 */
export async function planEnvironmentDeploy(
  db: Db,
  params: {
    environmentId: string
    organizationId: string
    /** Required: there is no default actor, so a new caller cannot skip the gate. */
    hostAccess: HostAccessActor
    /**
     * Who is deploying, for network shares. Omitted reads as `denied`, so a
     * caller that does not resolve it cannot deploy a share.
     */
    networkShares?: NetworkSharesActor
    /**
     * Swaps in the repository's compose file as the Base when the project
     * follows one. Omitted by callers that do not read repositories.
     */
    resolveProjectOptions?: ResolveProjectOptions
  },
  deps: PlanEnvironmentDeployDeps = {}
): Promise<PlannedDeploy | PlanDeployError> {
  const reconcile = deps.reconcileServicesFromCompose ?? reconcileServicesFromCompose
  const registerVolumes = deps.registerComposeVolumes ?? registerComposeVolumes
  const registerMounts = deps.registerComposeMounts ?? registerComposeMounts
  const listTasks = deps.listEnvironmentSlots ?? listEnvironmentSlots
  const listLabels = deps.listServerLabelsForServers ?? listServerLabelsForServers

  const loaded = await loadPlanContext(db, params)
  if ('kind' in loaded) return loaded
  const { envRow, projectRow, resolvedOptions, merged } = loaded

  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, params.organizationId))
    .limit(1)
  const orgOptions = parseOrganizationOptions(orgRow?.options)
  const composeGatedFieldsEnabled = resolveComposeGatedFieldsEnabled(orgOptions)
  const composeRemoteBuildSourcesEnabled = resolveComposeRemoteBuildSourcesEnabled(orgOptions)

  // Before anything is written. `reconcile` below creates and retires `service`
  // rows, and `registerVolumes` / `registerMounts` further down create `storage`
  // and `mount` rows — all from a document that, if it is going to be refused,
  // must not have shaped the control plane on its way to being refused. Planning
  // used to run first and the refusal came later, per server, which left rows
  // behind for a deploy that never happened.
  const rejected = validateComposeForDeploy(merged, {
    composeGatedFieldsEnabled,
    composeRemoteBuildSourcesEnabled,
  })
  if (rejected) return { kind: 'compose_rejected', error: rejected }
  const access = await authorizeHostAccess(
    db,
    envRow,
    params.organizationId,
    merged,
    params.hostAccess,
    deps.recordAudit ?? recordAudit
  )
  if ('error' in access) return { kind: 'compose_rejected', error: access.error }
  const shareGate = await authorizeNetworkShares(
    envRow,
    merged,
    params.networkShares ?? { kind: 'denied' }
  )
  if ('error' in shareGate) return { kind: 'compose_rejected', error: shareGate.error }
  let shares = shareGate.shares

  await reconcile(db, params.environmentId, merged)

  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
      options: service.options,
    })
    .from(service)
    .where(eq(service.environmentId, params.environmentId))

  const planned = plannedServicesFromRows(serviceRows, merged)

  const [fabricRow] = await db
    .select({ id: fabric.id, isEnabled: fabric.isEnabled })
    .from(fabric)
    .where(eq(fabric.organizationId, params.organizationId))
    .limit(1)

  const existingTasks = await listTasks(db, params.environmentId)
  const fleet = await loadFleet(db, params.organizationId, listLabels)
  const pinServerId = envRow.serverId
  const defaultServerId = projectRow.defaultServerId ?? null
  const registerServerId = pinServerId ?? defaultServerId
  if (registerServerId) {
    await registerVolumes(db, {
      document: merged,
      organizationId: params.organizationId,
      environmentId: params.environmentId,
      serverId: registerServerId,
    })
    await registerMounts(db, {
      document: merged,
      environmentId: params.environmentId,
    })
  }
  const storagePins = await loadStoragePins(db, params.organizationId, params.environmentId)
  // Pure pair rules for the planner: a network whose servers all share a
  // trusted LAN needs no TurboFabric. Read only when something could span.
  const pairRules = await loadPairRulesIfSpanning(db, params.organizationId, fleet, merged)

  const plan = planEnvironmentSchedule({
    pinServerId,
    defaultServerId,
    fabricEnabled: fabricRow !== undefined && fabricRow.isEnabled !== false,
    servers: fleet,
    services: planned,
    // `turbofabric_required` is decided from authored `driver: overlay` intent,
    // not from the server count, so the planner needs the merged document.
    document: merged,
    existingTasks: existingTasks.map((task) => ({
      serviceId: task.serviceId,
      slot: task.slot,
      serverId: task.serverId,
    })),
    storagePins,
    ...pairRules,
  })

  // The server half, over exactly the servers this plan dispatches to.
  const serverHalf = await checkSharesOnPlannedServers(db, plan, shares)
  if ('kind' in serverHalf) return serverHalf
  shares = serverHalf.shares

  return {
    plan,
    composeValidated: true,
    hostLevelApproved: access.hostLevelApproved,
    ...(access.hostAccessUse ? { hostAccessUse: access.hostAccessUse } : {}),
    remoteBuildSourcesApproved: composeRemoteBuildSourcesEnabled,
    allowNetworkShares: shares !== null && plan.ok,
    ...(shares === null ? {} : { networkShares: shares }),
    pinServerId,
    defaultServerId,
    fabricEnabled: fabricRow !== undefined && fabricRow.isEnabled !== false,
    fabricId: fabricRow?.id ?? null,
    merged,
    serviceRows,
    projectId: projectRow.id,
    projectOptions: resolvedOptions.options,
    composeBase: resolvedOptions.base,
    ...(resolvedOptions.pin ? { composeBasePin: resolvedOptions.pin } : {}),
    ...(resolvedOptions.unreadable ? { composeBaseUnreadable: resolvedOptions.unreadable } : {}),
    ...(resolvedOptions.read ? { composeBaseRead: resolvedOptions.read } : {}),
  }
}
