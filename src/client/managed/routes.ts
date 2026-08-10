import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import type { DerivedSecretsConfig } from '../authn/secrets.ts'
import { getDb } from '../../db.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  container,
  environment,
  managed,
  node,
  organization,
  principal,
  project,
  server,
  service,
  workspace,
} from '../../lib/db/schema.ts'
import { getManagedEngineSpec } from '../../lib/managed/index.ts'
import {
  clampManagedResources,
  type ManagedSettings,
} from '../../lib/managed/settings.ts'
import { isManagedEngineCode } from '../../lib/managed/types.ts'
import { parseResourceLimits } from '../../lib/resource-limits.ts'
import {
  createManagedPrincipal,
  isManagedUsernameTaken,
  listManagedPrincipals,
  lockOrganizationsForUpdate,
  resolveAvailableManagedRootUsername,
  resolveManagedOwningOrganizationIds,
  rotatePrincipalPassword,
  USERNAME_IN_USE_ERROR,
} from '../principals/store.ts'
import {
  assertDispatchInfrastructure,
} from '../servers/command-dispatch.ts'
import {
  getOrgId,
  parseJsonBody,
  assertCanManageOr403,
  requireStringField,
} from '../shared.ts'
import {
  assertServerDatacenterReady,
} from '../../lib/net/datacenter-networks.ts'
import {
  privateEndpointErrorResponse,
  resolvePrivateEndpoint,
  type PrivateEndpointTransport,
} from '../../lib/net/private-endpoint.ts'
import {
  authorizeManagedRequest,
  assertManagedNotBusy,
  assertTargetServerOnline,
  loadManagedContext,
  requireManagedCreateServerId,
  resolveManagedTargetServerId,
  type ManagedContext,
} from './context.ts'
import {
  hasBindingsForDatabase,
  hasBindingsForPrincipal,
  listBindingImpactForDatabase,
  listBindingImpactForPrincipal,
} from '../bindings/impact.ts'
import { materializeBindingsForPrincipal } from '../bindings/materialize.ts'
import {
  enqueueManagedDestroyFanout,
  enqueueManagedLifecycleFanout,
  enqueuePreparedManagedApply,
  enqueueTypedCommand,
  isPrepareError,
  mapManagedApplyPrepareError,
  prepareManagedApplyPayloads,
  preflightManagedApplyInfrastructure,
  type ManagedApplyPrepareError,
  type PreparedManagedMemberApply,
} from './apply-prepare.ts'
import {
  buildManagedBackupCreatePayload,
  buildManagedBackupDeletePayload,
  buildManagedRestorePayload,
  enqueueManagedBackup,
  enqueueManagedRestore,
  isManagedBackupApiError,
  mapManagedBackupApiError,
  resolveBackupDatabase,
} from './backups.ts'
import { fetchManagedLogs, parseLogsTailQuery } from './logs.ts'
import {
  countReplicas,
  deleteManagedMember,
  ensureManagedPrimaryMember,
  findManagedMember,
  insertManagedReplicaMember,
  listManagedMembers,
  listManagedMembersForManagedIds,
  listSerializedManagedMembers,
  MANAGED_MAX_REPLICAS,
  nextReplicaOrdinal,
  serializeManagedMember,
  updateManagedMemberReadEligible,
  type ManagedMemberRow,
} from './members.ts'
import {
  parseManagedRowOptions,
  writeManagedRowOptions,
  type ManagedBackupRecord,
  type ManagedRowOptions,
} from './options.ts'
import {
  buildEmptyManagedDetailResponse,
  buildFencePromotePendingResponse,
  buildManagedDeleteHardResponse,
  buildManagedDeleteQueuedResponse,
  buildManagedDestroyQueuedResponse,
  buildOrgManagedListEntry,
  buildPromoteQueuedResponse,
  buildQueuedFanoutResponse,
  buildStatusMemberView,
  canHardDeleteManaged,
  evaluateManagedDatabaseDelete,
  evaluateManagedUserDropGuard,
  evaluateManagedUserRotateGuard,
  evaluatePromoteLagHttpGate,
  evaluatePromoteMemberRole,
  evaluateReplicaPlacementPrechecks,
  findManagedBackupById,
  isManagedRootPrincipal,
  isManagedReplicationPrincipal,
  isPlainObject,
  managedSessionPaths,
  mergeCreateSettings,
  mergeManagedPatchSettings,
  nextDatabasesAfterCreate,
  nextDatabasesAfterDelete,
  parseManagedCreateDisplayName,
  parseManagedLifecycleAction,
  parseManagedUserCreateFields,
  parseMemberReadEligibleCreate,
  parseMemberReadEligiblePatch,
  parsePromoteForce,
  pickPrimaryCommandResult,
  readInitialDatabase,
  resolveManagedConnectionListener,
  resolveManagedServerId,
  serializeContainerRow,
  serializeManagedUser,
  sortManagedBackupsDesc,
  validateManagedDatabaseCreateName,
} from './routes-helpers.ts'
import {
  buildConnectionPayload,
  parseManagedResidual,
  serializeManagedRow,
} from './serialize.ts'

async function findManagedForEnvironment(db: NonNullable<ReturnType<typeof getDb>>, environmentId: string) {
  const [row] = await db
    .select({
      id: managed.id,
      environmentId: managed.environmentId,
      displayName: managed.name,
      engine: managed.engine,
      status: managed.status,
      metadata: managed.metadata,
      options: managed.options,
      serverId: managed.serverId,
      createdAt: managed.createdAt,
      updatedAt: managed.updatedAt,
    })
    .from(managed)
    .where(eq(managed.environmentId, environmentId))
    .limit(1)
  return row ?? null
}

async function loadResourceLimits(
  db: NonNullable<ReturnType<typeof getDb>>,
  organizationId: string,
  serverId: string,
) {
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const [serverRow] = await db
    .select({ options: server.options })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  const orgLimits = parseResourceLimits(
    isPlainObject(orgRow?.options) ? orgRow.options.resourceLimits : null,
  ) ?? {}
  const serverLimits = parseResourceLimits(
    isPlainObject(serverRow?.options) ? serverRow.options.resourceLimits : null,
  ) ?? {}
  return { orgLimits, serverLimits }
}

/**
 * Restore a principal's previous password hash after a failed apply so a
 * rotate-password request that could not be enqueued/materialized does not
 * leave the stored credential out of sync with the (unrotated) live engine.
 */
async function restorePreviousPrincipalPassword(
  db: NonNullable<ReturnType<typeof getDb>>,
  principalId: string,
  previousPassword: string | null | undefined,
): Promise<void> {
  if (typeof previousPassword !== 'string') return
  await db
    .update(principal)
    .set({ password: previousPassword, updatedAt: new Date().toISOString() })
    .where(eq(principal.id, principalId))
}

/**
 * Gate a promote request behind replication-lag freshness unless the caller
 * explicitly forced it. Returns a 409 response when the gate blocks, null
 * when the promote may proceed.
 */
function assertManagedPromoteLagAllowed(
  c: Context<AppEnv>,
  member: ManagedMemberRow,
  force: boolean,
): Response | null {
  const serialized = serializeManagedMember(member, null)
  const gate = evaluatePromoteLagHttpGate(serialized.replication, force)
  return gate !== null ? c.json({ error: gate }, 409) : null
}

/**
 * Before promoting a replica, fence an online primary (stop it and queue a
 * follow-up promote once that fence lands) or, when the primary is already
 * offline, mark it `needs_resync` and let the caller proceed to promote
 * immediately. Returns a Response when the caller should return it as-is
 * (the fence was queued), or null to continue with the promote.
 */
async function fenceOrResyncPrimaryForPromote(options: {
  c: Context<AppEnv>
  db: NonNullable<ReturnType<typeof getDb>>
  commandQueue: CommandQueue
  auth: { userId: string }
  ctx: ManagedContext
  row: { id: string }
  member: ManagedMemberRow
  primary: ManagedMemberRow | undefined
}): Promise<Response | null> {
  const { c, db, commandQueue, auth, ctx, row, member, primary } = options
  if (!primary) return null

  const primaryOnline = await assertTargetServerOnline(c, db, primary.serverId)
  if (primaryOnline instanceof Response) {
    await db
      .update(node)
      .set({ status: 'needs_resync', updatedAt: new Date().toISOString() })
      .where(eq(node.id, primary.id))
    return null
  }

  const fence = await enqueueTypedCommand(c, db, commandQueue, {
    userId: auth.userId,
    serverId: primary.serverId,
    type: 'managed.lifecycle',
    payload: {
      managedId: row.id,
      action: 'stop',
      memberId: primary.id,
      engine: ctx.spec.engine,
    },
    expiresAtMs: 600_000,
    managedId: row.id,
    setApplying: true,
    metadata: {
      followUpPromote: {
        serverId: member.serverId,
        payload: {
          managedId: row.id,
          memberId: member.id,
          engine: ctx.spec.engine,
          demoteMemberId: primary.id,
        },
      },
    },
  })
  if (fence instanceof Response) return fence

  return c.json(buildFencePromotePendingResponse({
    commandId: fence.commandId,
    serverId: fence.serverId,
  }))
}

class ManagedPrepareRollbackError extends Error {
  readonly prepareError: ManagedApplyPrepareError

  constructor(prepareError: ManagedApplyPrepareError) {
    super(prepareError.kind)
    this.name = 'ManagedPrepareRollbackError'
    this.prepareError = prepareError
  }
}

/**
 * Clear never-applied pending container rows for an environment so
 * deleteProjectCascade does not treat them as active after the managed row is
 * removed. Same predicate as the hard-delete path on DELETE …/managed.
 */
async function clearPendingNullIdContainersForEnvironment(
  db: NonNullable<ReturnType<typeof getDb>>,
  environmentId: string,
): Promise<void> {
  const envServices = await db
    .select({ id: service.id })
    .from(service)
    .where(eq(service.environmentId, environmentId))
  const serviceIds = envServices.map((s) => s.id)
  if (serviceIds.length > 0) {
    await db.delete(container).where(
      and(
        inArray(container.serviceId, serviceIds),
        isNull(container.containerId),
        eq(container.status, 'pending'),
      ),
    )
  }
}

async function deleteManagedCompensation(
  db: NonNullable<ReturnType<typeof getDb>>,
  managedId: string,
  environmentId: string,
): Promise<void> {
  await clearPendingNullIdContainersForEnvironment(db, environmentId)
  await db.delete(managed).where(eq(managed.id, managedId))
}

const MANAGED_RETURNING = {
  id: managed.id,
  environmentId: managed.environmentId,
  displayName: managed.name,
  engine: managed.engine,
  status: managed.status,
  metadata: managed.metadata,
  options: managed.options,
  serverId: managed.serverId,
  createdAt: managed.createdAt,
  updatedAt: managed.updatedAt,
} as const

type ManagedRow = NonNullable<Awaited<ReturnType<typeof findManagedForEnvironment>>>

async function clearIncompleteManagedCreate(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  existing: ManagedRow,
  fallbackServerId: string | null,
): Promise<Response | null> {
  if (existing.status === 'provisioning') {
    await deleteManagedCompensation(db, existing.id, existing.environmentId)
    return null
  }
  const serverId = resolveManagedServerId(existing, fallbackServerId)
  return c.json({
    ok: true as const,
    alreadyProvisioned: true as const,
    managed: serializeManagedRow(existing, serverId),
  })
}

async function resolveManagedCreatePlan(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  ctx: ManagedContext,
  organizationId: string,
  serverId: string,
  body: Record<string, unknown>,
): Promise<
  | {
    displayName: string
    settings: ManagedSettings
    initialDatabase: string
    rowOptions: ReturnType<typeof writeManagedRowOptions>
  }
  | Response
> {
  const displayNameResult = parseManagedCreateDisplayName(body)
  if (!displayNameResult.ok) {
    return c.json({ error: displayNameResult.error }, displayNameResult.status)
  }
  const displayName = displayNameResult.displayName

  let settings = mergeCreateSettings(ctx.spec, body)
  if (!settings) {
    return c.json({ error: 'managed_settings_invalid' }, 400)
  }

  const { orgLimits, serverLimits } = await loadResourceLimits(
    db,
    organizationId,
    serverId,
  )
  settings = clampManagedResources(settings, orgLimits, serverLimits)

  const infra = await preflightManagedApplyInfrastructure(c, db, {
    serverId,
    bind: settings.exposure.bind,
  })
  if (infra) return mapManagedApplyPrepareError(c, infra)

  const initialDatabase = readInitialDatabase(ctx.spec)
  return {
    displayName: displayName ?? ctx.envDisplayName ?? ctx.spec.displayName,
    settings,
    initialDatabase,
    rowOptions: writeManagedRowOptions({
      settings,
      databases: [initialDatabase],
      backups: [],
    }),
  }
}

async function insertManagedCreateTransaction(
  c: Context<AppEnv>,
  tx: NonNullable<ReturnType<typeof getDb>>,
  params: {
    environmentId: string
    ctx: ManagedContext
    serverId: string
    displayName: string
    rowOptions: ReturnType<typeof writeManagedRowOptions>
    initialDatabase: string
    dataEncryptionSecrets: DerivedSecretsConfig
  },
): Promise<{
  row: ManagedRow
  rootPassword: string
  prepared: PreparedManagedMemberApply[]
}> {
  const {
    environmentId,
    ctx,
    serverId,
    displayName,
    rowOptions,
    initialDatabase,
    dataEncryptionSecrets,
  } = params

  const [insertedManaged] = await tx
    .insert(managed)
    .values({
      environmentId,
      serverId,
      name: displayName,
      engine: ctx.spec.engine,
      status: 'provisioning',
      metadata: {},
      options: rowOptions,
    })
    .returning(MANAGED_RETURNING)

  const managedId = insertedManaged?.id
  if (!managedId) {
    throw new TypeError('Failed to create managed row')
  }

  await ensureManagedPrimaryMember(tx, { managedId, serverId })

  const owningOrgIds = await resolveManagedOwningOrganizationIds(tx, managedId, [
    serverId,
  ])
  await lockOrganizationsForUpdate(tx, owningOrgIds)

  const rootUsername = await resolveAvailableManagedRootUsername(
    tx,
    owningOrgIds,
    ctx.spec.rootUsername,
    managedId,
    ctx.spec.userOperations.identifier,
  )

  const { principalId, password } = await createManagedPrincipal(
    tx,
    dataEncryptionSecrets,
    {
      managedId,
      provider: ctx.spec.principalProvider,
      username: rootUsername,
      metadata: {
        managedRoot: true,
        engine: ctx.spec.engine,
        databases: [initialDatabase],
      },
    },
  )

  const [updated] = await tx
    .update(managed)
    .set({
      metadata: {
        rootPrincipalId: principalId,
        rootUsername,
      },
      updatedAt: new Date().toISOString(),
    })
    .where(eq(managed.id, managedId))
    .returning(MANAGED_RETURNING)

  const row = updated ?? insertedManaged
  const parsedOptions = parseManagedRowOptions(ctx.spec, row.options)
  if (!parsedOptions) {
    throw new TypeError('Invalid managed options after create')
  }

  const prepared = await prepareManagedApplyPayloads(c, tx, {
    managedRow: row,
    spec: ctx.spec,
    settings: parsedOptions.settings,
    databases: parsedOptions.databases,
    serverId,
    environmentId: ctx.environmentId,
    organizationId: ctx.organizationId,
    rootUsername,
  })
  if (isPrepareError(prepared)) {
    throw new ManagedPrepareRollbackError(prepared)
  }

  return {
    row,
    rootPassword: password,
    prepared: prepared.members,
  }
}

type PreparedManagedApply = {
  commandQueue: CommandQueue
  members: PreparedManagedMemberApply[]
}

/** Busy / online / dispatch / daemon-key / bind checks — no credential payload. */
async function assertManagedApplyReady(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  ctx: ManagedContext,
  managedRow: NonNullable<Awaited<ReturnType<typeof findManagedForEnvironment>>>,
  options: ManagedRowOptions,
  targetServerId: string,
): Promise<CommandQueue | Response> {
  const busy = assertManagedNotBusy(c, managedRow.status)
  if (busy) return busy

  const offline = await assertTargetServerOnline(c, db, targetServerId)
  if (offline) return offline

  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return commandQueue

  const infra = await preflightManagedApplyInfrastructure(c, db, {
    serverId: targetServerId,
    bind: options.settings.exposure.bind,
  })
  if (infra) return mapManagedApplyPrepareError(c, infra)

  return commandQueue
}

async function prepareApplyForManaged(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  ctx: ManagedContext,
  managedRow: NonNullable<Awaited<ReturnType<typeof findManagedForEnvironment>>>,
  options: ManagedRowOptions,
  targetServerId: string,
  extra?: {
    dropUsers?: string[]
    dropDatabases?: string[]
    omitPrincipalIds?: string[]
    excludeMemberIds?: string[]
  },
): Promise<PreparedManagedApply | Response> {
  const commandQueue = await assertManagedApplyReady(
    c,
    db,
    ctx,
    managedRow,
    options,
    targetServerId,
  )
  if (commandQueue instanceof Response) return commandQueue

  const residual = parseManagedResidual(managedRow.metadata)
  const prepared = await prepareManagedApplyPayloads(c, db, {
    managedRow,
    spec: ctx.spec,
    settings: options.settings,
    databases: options.databases,
    serverId: targetServerId,
    environmentId: ctx.environmentId,
    organizationId: ctx.organizationId,
    rootUsername: residual.rootUsername ?? ctx.spec.rootUsername,
    dropUsers: extra?.dropUsers,
    dropDatabases: extra?.dropDatabases,
    omitPrincipalIds: extra?.omitPrincipalIds,
    excludeMemberIds: extra?.excludeMemberIds,
  })
  if (isPrepareError(prepared)) {
    return mapManagedApplyPrepareError(c, prepared)
  }

  return { commandQueue, members: prepared.members }
}

async function runApplyForManaged(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  params: {
    userId: string
    ctx: ManagedContext
    managedRow: ManagedRow
    options: ManagedRowOptions
    targetServerId: string
  },
): Promise<Response> {
  const { userId, ctx, managedRow, options, targetServerId } = params
  const prepared = await prepareApplyForManaged(
    c,
    db,
    ctx,
    managedRow,
    options,
    targetServerId,
  )
  if (prepared instanceof Response) return prepared

  const enqueued = await enqueuePreparedManagedApply(c, db, prepared.commandQueue, {
    userId,
    managedId: managedRow.id,
    members: prepared.members,
  })
  if (enqueued instanceof Response) return enqueued

  const primary = pickPrimaryCommandResult(enqueued)
  return c.json({
    ok: true as const,
    results: enqueued,
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? targetServerId,
    status: 'queued' as const,
  })
}

async function createManagedAndEnqueueApply(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  params: {
    environmentId: string
    ctx: ManagedContext
    createServerId: string
    userId: string
    plan: {
      displayName: string
      rowOptions: ReturnType<typeof writeManagedRowOptions>
      initialDatabase: string
    }
    dataEncryptionSecrets: DerivedSecretsConfig
    commandQueue: CommandQueue
  },
): Promise<Response> {
  const {
    environmentId,
    ctx,
    createServerId,
    userId,
    plan,
    dataEncryptionSecrets,
    commandQueue,
  } = params

  let created: Awaited<ReturnType<typeof insertManagedCreateTransaction>>
  try {
    created = await db.transaction(async (tx) =>
      insertManagedCreateTransaction(c, tx, {
        environmentId,
        ctx,
        serverId: createServerId,
        displayName: plan.displayName,
        rowOptions: plan.rowOptions,
        initialDatabase: plan.initialDatabase,
        dataEncryptionSecrets,
      }))
  } catch (error) {
    if (error instanceof ManagedPrepareRollbackError) {
      return mapManagedApplyPrepareError(c, error.prepareError)
    }
    throw error
  }

  const enqueued = await enqueuePreparedManagedApply(c, db, commandQueue, {
    userId,
    managedId: created.row.id,
    members: created.prepared,
  })
  if (enqueued instanceof Response) {
    await deleteManagedCompensation(db, created.row.id, environmentId)
    return enqueued
  }

  const primary = pickPrimaryCommandResult(enqueued)
  const residual = parseManagedResidual(created.row.metadata)
  return c.json({
    ok: true as const,
    managed: serializeManagedRow(created.row, createServerId),
    commandId: primary?.commandId,
    serverId: primary?.serverId ?? createServerId,
    results: enqueued,
    rootPassword: created.rootPassword,
    rootUsername: residual.rootUsername ?? ctx.spec.rootUsername,
  })
}

async function resolveReplicaPlacement(
  c: Context<AppEnv>,
  db: NonNullable<ReturnType<typeof getDb>>,
  params: {
    primaryServerId: string
    serverId: string
    members: readonly ManagedMemberRow[]
  },
): Promise<
  Response | { toPrimaryTransport: PrivateEndpointTransport; ordinal: number }
> {
  const precheck = evaluateReplicaPlacementPrechecks(
    params.members,
    params.serverId,
    countReplicas(params.members),
    MANAGED_MAX_REPLICAS,
  )
  if (precheck) {
    return c.json({ error: precheck.error }, precheck.status)
  }

  const dcReady = await assertServerDatacenterReady(db, params.serverId)
  if (dcReady) {
    return c.json({ error: dcReady.kind }, 422)
  }

  const toPrimary = await resolvePrivateEndpoint(db, {
    fromServerId: params.serverId,
    toServerId: params.primaryServerId,
  })
  if ('kind' in toPrimary) return privateEndpointErrorResponse(c, toPrimary)
  const fromPrimary = await resolvePrivateEndpoint(db, {
    fromServerId: params.primaryServerId,
    toServerId: params.serverId,
  })
  if ('kind' in fromPrimary) return privateEndpointErrorResponse(c, fromPrimary)

  const offline = await assertTargetServerOnline(c, db, params.serverId)
  if (offline) return offline

  const ordinal = nextReplicaOrdinal(params.members)
  if (ordinal === null) {
    return c.json({ error: 'managed_replica_limit' }, 422)
  }

  return { toPrimaryTransport: toPrimary.transport, ordinal }
}

// Expanding the cluster onto a new server owner inherits that org's
// managed-login namespace — recheck every existing principal (incl. root)
// under a FOR UPDATE org lock before insert.
async function hasManagedUsernameNamespaceConflict(
  db: NonNullable<ReturnType<typeof getDb>>,
  managedId: string,
  serverId: string,
): Promise<boolean> {
  const clusterPrincipals = await listManagedPrincipals(db, managedId)
  return db.transaction(async (tx) => {
    const owningOrgIds = await resolveManagedOwningOrganizationIds(tx, managedId, [
      serverId,
    ])
    await lockOrganizationsForUpdate(tx, owningOrgIds)
    for (const entry of clusterPrincipals) {
      if (
        await isManagedUsernameTaken(tx, owningOrgIds, entry.username, entry.id)
      ) {
        return true
      }
    }
    return false
  })
}

export function registerManagedRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for managed routes')
  }

  for (const path of managedSessionPaths()) {
    router.use(path, createSessionMiddleware(opts.secrets))
  }

  router.post('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const existing = await findManagedForEnvironment(db, environmentId)
    if (existing) {
      // Incomplete creates never enqueued apply — remove so a fresh show-once
      // password can be issued. Successful creates leave status beyond
      // provisioning. This is not itself a create, so it displays whichever
      // server id is known (`managed.server_id`, falling back to the
      // environment's current placement) rather than hard-requiring one.
      const idempotent = await clearIncompleteManagedCreate(
        c,
        db,
        existing,
        ctx.serverId,
      )
      if (idempotent) return idempotent
    }

    // A brand-new managed row has no `server_id` pin of its own yet, so
    // creation is the one operation that still requires the environment's
    // placement — existing rows resolve via `managed.server_id` instead.
    const createServerId = requireManagedCreateServerId(c, ctx.serverId)
    if (createServerId instanceof Response) return createServerId

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const offline = await assertTargetServerOnline(c, db, createServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const plan = await resolveManagedCreatePlan(
      c,
      db,
      ctx,
      auth.organizationId,
      createServerId,
      body,
    )
    if (plan instanceof Response) return plan

    return createManagedAndEnqueueApply(c, db, {
      environmentId,
      ctx,
      createServerId,
      userId: auth.userId,
      plan,
      dataEncryptionSecrets,
      commandQueue,
    })
  })

  router.get('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) {
      return c.json(buildEmptyManagedDetailResponse(ctx.spec.rootUsername))
    }

    const serverId = resolveManagedServerId(row, ctx.serverId)
    const parsed = parseManagedRowOptions(ctx.spec, row.options)
    if (!parsed) {
      return c.json({ error: 'Invalid managed options' }, 400)
    }

    const residual = parseManagedResidual(row.metadata)
    const rootUsername = residual.rootUsername ?? ctx.spec.rootUsername
    const database = parsed.databases[0] ?? readInitialDatabase(ctx.spec)
    const listener = serverId
      ? await resolveManagedConnectionListener(db, {
        serverId,
        protocolPort: ctx.spec.defaultPort,
        exposure: parsed.settings.exposure,
      })
      : null
    const connection = listener
      ? buildConnectionPayload(ctx.spec, {
        host: listener.host,
        port: listener.port,
        database,
        username: rootUsername,
        settings: parsed.settings,
      })
      : null

    const serverRows = serverId
      ? await db
        .select({
          id: server.id,
          displayName: server.name,
          hostname: server.hostname,
        })
        .from(server)
        .where(eq(server.id, serverId))
        .limit(1)
      : []
    const serverRow = serverRows[0]
    const members = await listSerializedManagedMembers(db, row.id)

    return c.json({
      managed: serializeManagedRow(row, serverId, {
        host: listener?.host ?? null,
        port: listener?.port ?? null,
      }),
      connection,
      settings: parsed.settings,
      server: serverRow ?? null,
      rootUsername,
      members,
    })
  })

  router.patch('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    // Resource limits are server-specific — clamp against the host that
    // actually runs the engine (`managed.server_id`), not the (possibly
    // drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const current = parseManagedRowOptions(ctx.spec, row.options)
    if (!current) return c.json({ error: 'Invalid managed options' }, 400)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const mergedSettings = mergeManagedPatchSettings(
      ctx.spec,
      current.settings,
      body,
    )
    if (!mergedSettings) {
      return c.json({ error: 'managed_settings_invalid' }, 400)
    }

    const { orgLimits, serverLimits } = await loadResourceLimits(
      db,
      auth.organizationId,
      targetServerId,
    )
    const clamped = clampManagedResources(mergedSettings, orgLimits, serverLimits)

    const nextOptions = writeManagedRowOptions({
      settings: clamped,
      databases: current.databases,
      backups: current.backups,
    })

    const [updated] = await db
      .update(managed)
      .set({ options: nextOptions, updatedAt: new Date().toISOString() })
      .where(eq(managed.id, row.id))
      .returning({
        id: managed.id,
        environmentId: managed.environmentId,
        displayName: managed.name,
        engine: managed.engine,
        status: managed.status,
        metadata: managed.metadata,
        options: managed.options,
        serverId: managed.serverId,
        createdAt: managed.createdAt,
        updatedAt: managed.updatedAt,
      })

    return c.json({
      ok: true,
      managed: serializeManagedRow(updated ?? row, targetServerId),
      settings: clamped,
    })
  })

  router.post('/environments/:id/managed/apply', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    return runApplyForManaged(c, db, {
      userId: auth.userId,
      ctx,
      managedRow: row,
      options,
      targetServerId,
    })
  })

  router.post('/environments/:id/managed/lifecycle', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const actionParsed = parseManagedLifecycleAction(body)
    if (!actionParsed.ok) {
      return c.json({ error: actionParsed.error }, actionParsed.status)
    }
    const { action } = actionParsed

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    await ensureManagedPrimaryMember(db, {
      managedId: row.id,
      serverId: targetServerId,
    })
    const members = await listManagedMembers(db, row.id)
    for (const member of members) {
      const offline = await assertTargetServerOnline(c, db, member.serverId)
      if (offline) return offline
    }

    const enqueued = await enqueueManagedLifecycleFanout(c, db, commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      action,
      members,
      engine: ctx.spec.engine,
    })
    if (enqueued instanceof Response) return enqueued
    return c.json(buildQueuedFanoutResponse(enqueued, targetServerId))
  })

  router.delete('/environments/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const canHardDelete = canHardDeleteManaged(row.status, row.serverId)

    if (canHardDelete) {
      // Clear never-applied pending container rows so deleteProjectCascade does
      // not treat them as active (`isActiveContainerStatus('pending')` is true).
      await clearPendingNullIdContainersForEnvironment(db, environmentId)
      await db.delete(managed).where(eq(managed.id, row.id))
      return c.json(buildManagedDeleteHardResponse())
    }

    // `canHardDelete` already covers `!row.serverId`, so `managed.server_id`
    // is guaranteed here — resolve through the shared helper anyway for
    // consistency with every other existing-row route.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    await ensureManagedPrimaryMember(db, {
      managedId: row.id,
      serverId: targetServerId,
    })
    const members = await listManagedMembers(db, row.id)
    for (const member of members) {
      const offline = await assertTargetServerOnline(c, db, member.serverId)
      if (offline) return offline
    }

    // Single-click delete: stamp deleteAfterDestroy on primary only so the
    // managed row is deleted exactly once after the last host teardown.
    const enqueued = await enqueueManagedDestroyFanout(c, db, commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      removeVolumes: true,
      members,
      deleteAfterDestroy: true,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json(buildManagedDeleteQueuedResponse(enqueued, targetServerId))
  })

  router.post('/environments/:id/managed/root-password', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const residual = parseManagedResidual(row.metadata)
    const rootPrincipalId = residual.rootPrincipalId
    if (!rootPrincipalId) {
      return c.json({ error: 'root_principal_missing' }, 500)
    }

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const commandQueue = await assertManagedApplyReady(
      c,
      db,
      ctx,
      row,
      options,
      targetServerId,
    )
    if (commandQueue instanceof Response) return commandQueue

    const [previous] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, rootPrincipalId))
      .limit(1)
    const previousPassword = previous?.password

    const { plaintext } = await rotatePrincipalPassword(
      db,
      dataEncryptionSecrets,
      rootPrincipalId,
    )

    const residualForApply = parseManagedResidual(row.metadata)
    const preparedApply = await prepareManagedApplyPayloads(c, db, {
      managedRow: row,
      spec: ctx.spec,
      settings: options.settings,
      databases: options.databases,
      serverId: targetServerId,
      environmentId: ctx.environmentId,
      organizationId: ctx.organizationId,
      rootUsername: residualForApply.rootUsername ?? ctx.spec.rootUsername,
    })
    if (isPrepareError(preparedApply)) {
      if (typeof previousPassword === 'string') {
        await db
          .update(principal)
          .set({ password: previousPassword, updatedAt: new Date().toISOString() })
          .where(eq(principal.id, rootPrincipalId))
      }
      return mapManagedApplyPrepareError(c, preparedApply)
    }

    const enqueued = await enqueuePreparedManagedApply(c, db, commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      members: preparedApply.members,
    })
    if (enqueued instanceof Response) {
      if (typeof previousPassword === 'string') {
        await db
          .update(principal)
          .set({ password: previousPassword, updatedAt: new Date().toISOString() })
          .where(eq(principal.id, rootPrincipalId))
      }
      return enqueued
    }

    const primaryResult = pickPrimaryCommandResult(enqueued)
    const redeployRequired = await listBindingImpactForPrincipal(db, rootPrincipalId)
    return c.json({
      ok: true,
      rootPassword: plaintext,
      commandId: primaryResult?.commandId,
      serverId: primaryResult?.serverId ?? targetServerId,
      results: enqueued,
      redeployRequired,
    })
  })

  router.get('/environments/:id/managed/users', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ users: [] })

    const users = await listManagedPrincipals(db, row.id)
    return c.json({
      users: users
        .filter(
          (entry) =>
            !isManagedRootPrincipal(entry.metadata) &&
            !isManagedReplicationPrincipal(entry.metadata),
        )
        .map((entry) => serializeManagedUser(entry)),
    })
  })

  router.post('/environments/:id/managed/users', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const residual = parseManagedResidual(row.metadata)
    const fields = parseManagedUserCreateFields(
      c,
      ctx,
      body,
      options,
      residual.rootUsername,
    )
    if (fields instanceof Response) return fields
    const { username, databases, privileges } = fields

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const commandQueue = await assertManagedApplyReady(
      c,
      db,
      ctx,
      row,
      options,
      targetServerId,
    )
    if (commandQueue instanceof Response) return commandQueue

    // Same-cluster collision, owning-org namespace probe, and principal insert
    // share one txn so the organization FOR UPDATE lock covers the insert —
    // otherwise concurrent creates can pass the check before either inserts.
    // include targetServerId so legacy rows self-heal a primary member first.
    const userCreate = await db.transaction(async (tx) => {
      const existingUsers = await listManagedPrincipals(tx, row.id)
      if (existingUsers.some((entry) => entry.username === username)) {
        return { ok: false as const, error: 'managed_user_exists' as const }
      }

      await ensureManagedPrimaryMember(tx, {
        managedId: row.id,
        serverId: targetServerId,
      })
      const owningOrgIds = await resolveManagedOwningOrganizationIds(tx, row.id, [
        targetServerId,
      ])
      await lockOrganizationsForUpdate(tx, owningOrgIds)
      if (await isManagedUsernameTaken(tx, owningOrgIds, username)) {
        return { ok: false as const, error: USERNAME_IN_USE_ERROR }
      }

      const created = await createManagedPrincipal(tx, dataEncryptionSecrets, {
        managedId: row.id,
        provider: ctx.spec.principalProvider,
        username,
        metadata: {
          engine: ctx.spec.engine,
          databases,
          privileges,
        },
      })
      return { ok: true as const, ...created }
    })
    if (!userCreate.ok) {
      return c.json({ error: userCreate.error }, 409)
    }
    const { principalId, password } = userCreate

    const preparedApply = await prepareManagedApplyPayloads(c, db, {
      managedRow: row,
      spec: ctx.spec,
      settings: options.settings,
      databases: options.databases,
      serverId: targetServerId,
      environmentId: ctx.environmentId,
      organizationId: ctx.organizationId,
      rootUsername: residual.rootUsername ?? ctx.spec.rootUsername,
    })
    if (isPrepareError(preparedApply)) {
      await db.delete(principal).where(eq(principal.id, principalId))
      return mapManagedApplyPrepareError(c, preparedApply)
    }

    const enqueued = await enqueuePreparedManagedApply(c, db, commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      members: preparedApply.members,
    })
    if (enqueued instanceof Response) {
      await db.delete(principal).where(eq(principal.id, principalId))
      return enqueued
    }

    const [createdUser] = await db
      .select({ createdAt: principal.createdAt })
      .from(principal)
      .where(eq(principal.id, principalId))
      .limit(1)

    const primaryResult = pickPrimaryCommandResult(enqueued)
    return c.json({
      ok: true,
      user: {
        id: principalId,
        username,
        databases,
        privileges,
        createdAt: createdUser?.createdAt ?? new Date().toISOString(),
      },
      password,
      commandId: primaryResult?.commandId,
      serverId: primaryResult?.serverId ?? targetServerId,
      results: enqueued,
    })
  })

  router.post('/environments/:id/managed/users/:principalId/password', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const principalId = c.req.param('principalId')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const [target] = await db
      .select({
        id: principal.id,
        metadata: principal.metadata,
        managedId: principal.managedId,
      })
      .from(principal)
      .where(and(eq(principal.id, principalId), eq(principal.managedId, row.id)))
      .limit(1)
    if (!target) return c.json({ error: 'Not found' }, 404)
    const rotateGuard = evaluateManagedUserRotateGuard(target.metadata)
    if (rotateGuard) {
      return c.json({ error: rotateGuard.error }, rotateGuard.status)
    }

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    if (!dataEncryptionSecrets) {
      return c.json({ error: 'Encryption unavailable' }, 503)
    }

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const commandQueue = await assertManagedApplyReady(
      c,
      db,
      ctx,
      row,
      options,
      targetServerId,
    )
    if (commandQueue instanceof Response) return commandQueue

    const [previous] = await db
      .select({ password: principal.password })
      .from(principal)
      .where(eq(principal.id, principalId))
      .limit(1)
    const previousPassword = previous?.password

    const { plaintext } = await rotatePrincipalPassword(
      db,
      dataEncryptionSecrets,
      principalId,
    )

    const materializeResult = await materializeBindingsForPrincipal(
      db,
      dataEncryptionSecrets,
      principalId,
    )
    if (!('ok' in materializeResult)) {
      await restorePreviousPrincipalPassword(db, principalId, previousPassword)
      return c.json({ error: materializeResult.kind }, 422)
    }

    const residual = parseManagedResidual(row.metadata)
    const preparedApply = await prepareManagedApplyPayloads(c, db, {
      managedRow: row,
      spec: ctx.spec,
      settings: options.settings,
      databases: options.databases,
      serverId: targetServerId,
      environmentId: ctx.environmentId,
      organizationId: ctx.organizationId,
      rootUsername: residual.rootUsername ?? ctx.spec.rootUsername,
    })
    if (isPrepareError(preparedApply)) {
      await restorePreviousPrincipalPassword(db, principalId, previousPassword)
      return mapManagedApplyPrepareError(c, preparedApply)
    }

    const enqueued = await enqueuePreparedManagedApply(c, db, commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      members: preparedApply.members,
    })
    if (enqueued instanceof Response) {
      await restorePreviousPrincipalPassword(db, principalId, previousPassword)
      return enqueued
    }

    const primaryResult = pickPrimaryCommandResult(enqueued)
    const redeployRequired = await listBindingImpactForPrincipal(db, principalId)
    return c.json({
      ok: true,
      password: plaintext,
      commandId: primaryResult?.commandId,
      serverId: primaryResult?.serverId ?? targetServerId,
      results: enqueued,
      redeployRequired,
    })
  })

  router.delete('/environments/:id/managed/users/:principalId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const principalId = c.req.param('principalId')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const [target] = await db
      .select({
        id: principal.id,
        username: principal.username,
        metadata: principal.metadata,
        kind: principal.kind,
        provider: principal.provider,
        managedId: principal.managedId,
        options: principal.options,
        password: principal.password,
        createdAt: principal.createdAt,
        updatedAt: principal.updatedAt,
      })
      .from(principal)
      .where(and(eq(principal.id, principalId), eq(principal.managedId, row.id)))
      .limit(1)
    if (!target) return c.json({ error: 'Not found' }, 404)

    const dropGuard = evaluateManagedUserDropGuard(target.metadata)
    if (dropGuard) {
      return c.json({ error: dropGuard.error }, dropGuard.status)
    }

    if (await hasBindingsForPrincipal(db, principalId)) {
      const redeployRequired = await listBindingImpactForPrincipal(db, principalId)
      return c.json({
        error: 'managed_user_has_bindings',
        services: redeployRequired.services,
      }, 409)
    }

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const prepared = await prepareApplyForManaged(c, db, ctx, row, options, targetServerId, {
      dropUsers: [target.username],
      omitPrincipalIds: [principalId],
    })
    if (prepared instanceof Response) return prepared

    await db.delete(principal).where(eq(principal.id, principalId))

    const enqueued = await enqueuePreparedManagedApply(c, db, prepared.commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      members: prepared.members,
    })
    if (enqueued instanceof Response) {
      await db.insert(principal).values({
        id: target.id,
        kind: target.kind,
        provider: target.provider,
        username: target.username,
        managedId: target.managedId,
        metadata: target.metadata,
        options: target.options,
        password: target.password,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
      })
      return enqueued
    }

    const primaryFanout = pickPrimaryCommandResult(enqueued)
    return c.json({
      ok: true,
      commandId: primaryFanout?.commandId,
      serverId: primaryFanout?.serverId ?? targetServerId,
      results: enqueued,
    })
  })

  router.get('/environments/:id/managed/databases', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ databases: [] })

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)
    return c.json({ databases: options.databases })
  })

  router.post('/environments/:id/managed/databases', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const name = requireStringField(c, body, 'name')
    if (name instanceof Response) return name

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const { pattern, maxLength } = ctx.spec.userOperations.identifier
    const nameError = validateManagedDatabaseCreateName(
      name,
      options.databases,
      { pattern, maxLength },
    )
    if (nameError) {
      return c.json({ error: nameError.error }, nameError.status)
    }

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const nextDatabases = nextDatabasesAfterCreate(options.databases, name)
    const nextOptions = writeManagedRowOptions({
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    })

    const prepared = await prepareApplyForManaged(c, db, ctx, row, {
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    }, targetServerId)
    if (prepared instanceof Response) return prepared

    const previousOptions = row.options
    await db
      .update(managed)
      .set({ options: nextOptions, updatedAt: new Date().toISOString() })
      .where(eq(managed.id, row.id))

    const enqueued = await enqueuePreparedManagedApply(c, db, prepared.commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      members: prepared.members,
    })
    if (enqueued instanceof Response) {
      await db
        .update(managed)
        .set({
          options: previousOptions,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(managed.id, row.id))
      return enqueued
    }

    const primaryFanout = pickPrimaryCommandResult(enqueued)
    return c.json({
      ok: true,
      databases: nextDatabases,
      commandId: primaryFanout?.commandId,
      serverId: primaryFanout?.serverId ?? targetServerId,
      results: enqueued,
    })
  })

  router.delete('/environments/:id/managed/databases/:databaseName', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const databaseName = decodeURIComponent(c.req.param('databaseName'))
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const initialDatabase = readInitialDatabase(ctx.spec)
    const deleteError = evaluateManagedDatabaseDelete(
      databaseName,
      options.databases,
      initialDatabase,
    )
    if (deleteError) {
      return c.json({ error: deleteError.error }, deleteError.status)
    }

    if (await hasBindingsForDatabase(db, { managedId: row.id, databaseName })) {
      const redeployRequired = await listBindingImpactForDatabase(db, {
        managedId: row.id,
        databaseName,
      })
      return c.json({
        error: 'managed_database_has_bindings',
        services: redeployRequired.services,
      }, 409)
    }

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const nextDatabases = nextDatabasesAfterDelete(
      options.databases,
      databaseName,
    )
    const nextOptions = writeManagedRowOptions({
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    })

    const prepared = await prepareApplyForManaged(c, db, ctx, row, {
      settings: options.settings,
      databases: nextDatabases,
      backups: options.backups,
    }, targetServerId, { dropDatabases: [databaseName] })
    if (prepared instanceof Response) return prepared

    const previousOptions = row.options
    await db
      .update(managed)
      .set({ options: nextOptions, updatedAt: new Date().toISOString() })
      .where(eq(managed.id, row.id))

    const enqueued = await enqueuePreparedManagedApply(c, db, prepared.commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      members: prepared.members,
    })
    if (enqueued instanceof Response) {
      await db
        .update(managed)
        .set({
          options: previousOptions,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(managed.id, row.id))
      return enqueued
    }

    const primaryFanout = pickPrimaryCommandResult(enqueued)
    return c.json({
      ok: true,
      databases: nextDatabases,
      commandId: primaryFanout?.commandId,
      serverId: primaryFanout?.serverId ?? targetServerId,
      results: enqueued,
    })
  })


  router.get('/environments/:id/managed/members', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ members: [] })

    const members = await listSerializedManagedMembers(db, row.id)
    return c.json({ members })
  })

  router.post('/environments/:id/managed/members', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const primaryServerId = resolveManagedTargetServerId(c, row.serverId)
    if (primaryServerId instanceof Response) return primaryServerId

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const serverId = requireStringField(c, body, 'serverId')
    if (serverId instanceof Response) return serverId

    // Placement may land on a grant-visible server owned by another org —
    // authority is can(organization:manage on server), not server.organizationId
    // equality with the environment's org.
    const serverDenied = await assertCanManageOr403(c, 'server', serverId)
    if (serverDenied) return serverDenied

    await ensureManagedPrimaryMember(db, {
      managedId: row.id,
      serverId: primaryServerId,
    })
    const members = await listManagedMembers(db, row.id)

    const placement = await resolveReplicaPlacement(c, db, {
      primaryServerId,
      serverId,
      members,
    })
    if (placement instanceof Response) return placement

    const namespaceConflict = await hasManagedUsernameNamespaceConflict(
      db,
      row.id,
      serverId,
    )
    if (namespaceConflict) {
      return c.json({ error: USERNAME_IN_USE_ERROR }, 409)
    }

    const readEligible = parseMemberReadEligibleCreate(body)
    const member = await insertManagedReplicaMember(db, {
      managedId: row.id,
      serverId,
      ordinal: placement.ordinal,
      readEligible,
      replicationTransport: placement.toPrimaryTransport,
    })

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const prepared = await prepareApplyForManaged(
      c,
      db,
      ctx,
      row,
      options,
      primaryServerId,
    )
    if (prepared instanceof Response) {
      await deleteManagedMember(db, member.id)
      return prepared
    }

    const enqueued = await enqueuePreparedManagedApply(c, db, prepared.commandQueue, {
      userId: auth.userId,
      managedId: row.id,
      members: prepared.members,
    })
    if (enqueued instanceof Response) {
      await deleteManagedMember(db, member.id)
      return enqueued
    }

    const primary = pickPrimaryCommandResult(enqueued)
    const [serverRow] = await db
      .select({ name: server.name })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    return c.json({
      ok: true as const,
      member: serializeManagedMember(member, serverRow?.name ?? null),
      results: enqueued,
      commandId: primary?.commandId,
      serverId: primary?.serverId,
      status: 'queued' as const,
    })
  })

  router.patch('/environments/:id/managed/members/:memberId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const memberId = c.req.param('memberId')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const member = await findManagedMember(db, memberId)
    if (member?.managedId !== row.id) {
      return c.json({ error: 'Not found' }, 404)
    }

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const readEligibleParsed = parseMemberReadEligiblePatch(body)
    if (!readEligibleParsed.ok) {
      return c.json({ error: readEligibleParsed.error }, readEligibleParsed.status)
    }

    const updated = await updateManagedMemberReadEligible(
      db,
      memberId,
      readEligibleParsed.readEligible,
    )
    if (!updated) return c.json({ error: 'Not found' }, 404)

    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const applyResp = await runApplyForManaged(c, db, {
      userId: auth.userId,
      ctx,
      managedRow: row,
      options,
      targetServerId,
    })
    return applyResp
  })

  router.delete('/environments/:id/managed/members/:memberId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const memberId = c.req.param('memberId')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const member = await findManagedMember(db, memberId)
    if (member?.managedId !== row.id) {
      return c.json({ error: 'Not found' }, 404)
    }
    if (member.role === 'primary') {
      return c.json({ error: 'managed_member_is_primary' }, 409)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const offline = await assertTargetServerOnline(c, db, member.serverId)
    if (offline) return offline

    // Keep the member visible until destroy succeeds (consumer deletes the row).
    await db
      .update(node)
      .set({
        status: 'applying',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(node.id, member.id))

    await db
      .update(managed)
      .set({ status: 'applying', updatedAt: new Date().toISOString() })
      .where(eq(managed.id, row.id))

    const primaryServerId = resolveManagedTargetServerId(c, row.serverId)
    if (primaryServerId instanceof Response) return primaryServerId

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    // Prepare primary re-apply payload for post-destroy slot cleanup (consumer).
    // Exclude the removing member so desiredSlots/peers shrink.
    const prepared = await prepareApplyForManaged(
      c,
      db,
      ctx,
      row,
      options,
      primaryServerId,
      { excludeMemberIds: [member.id] },
    )
    if (prepared instanceof Response) return prepared

    const primaryPrepared = prepared.members.find(
      (m) => m.payload.memberRole === 'primary',
    )

    const destroyOne = await enqueueTypedCommand(c, db, commandQueue, {
      userId: auth.userId,
      serverId: member.serverId,
      type: 'managed.destroy',
      payload: {
        managedId: row.id,
        removeVolumes: true,
        memberId: member.id,
        deleteMemberAfterDestroy: true,
      },
      expiresAtMs: 600_000,
      metadata: primaryPrepared
        ? {
            pendingPrimaryReapply: {
              serverId: primaryPrepared.serverId,
              payload: primaryPrepared.payload,
            },
          }
        : undefined,
    })
    if (destroyOne instanceof Response) return destroyOne

    return c.json(buildManagedDestroyQueuedResponse({
      commandId: destroyOne.commandId,
      serverId: destroyOne.serverId,
    }))
  })

  router.post('/environments/:id/managed/members/:memberId/promote', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const memberId = c.req.param('memberId')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const member = await findManagedMember(db, memberId)
    if (member?.managedId !== row.id) {
      return c.json({ error: 'Not found' }, 404)
    }
    const roleError = evaluatePromoteMemberRole(member.role)
    if (roleError) {
      return c.json({ error: roleError.error }, roleError.status)
    }

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const force = parsePromoteForce(body)

    const lagGate = assertManagedPromoteLagAllowed(c, member, force)
    if (lagGate) return lagGate

    const offline = await assertTargetServerOnline(c, db, member.serverId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const members = await listManagedMembers(db, row.id)
    const primary = members.find((m) => m.role === 'primary')

    // Fence online primary then enqueue promote from the command consumer.
    // HTTP returns immediately with the fence (or promote) command id.
    const fenceResult = await fenceOrResyncPrimaryForPromote({
      c,
      db,
      commandQueue,
      auth,
      ctx,
      row,
      member,
      primary,
    })
    if (fenceResult) return fenceResult

    const enqueued = await enqueueTypedCommand(c, db, commandQueue, {
      userId: auth.userId,
      serverId: member.serverId,
      type: 'managed.promote',
      payload: {
        managedId: row.id,
        memberId: member.id,
        engine: ctx.spec.engine,
        ...(primary ? { demoteMemberId: primary.id } : {}),
      },
      expiresAtMs: 600_000,
      managedId: row.id,
      setApplying: true,
    })
    if (enqueued instanceof Response) return enqueued
    return c.json(buildPromoteQueuedResponse({
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    }))
  })


  router.get('/environments/:id/managed/status', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const row = await findManagedForEnvironment(db, environmentId)
    const residual = row ? parseManagedResidual(row.metadata) : {}

    const rows = await db
      .select({
        id: container.id,
        serviceId: container.serviceId,
        serverId: container.serverId,
        containerId: container.containerId,
        containerName: container.containerName,
        status: container.status,
        role: container.role,
        composeServiceName: container.composeServiceName,
        metadata: container.metadata,
        options: container.options,
        createdAt: container.createdAt,
        updatedAt: container.updatedAt,
      })
      .from(container)
      .innerJoin(service, eq(container.serviceId, service.id))
      .where(eq(service.environmentId, environmentId))

    const memberRows = row
      ? await listManagedMembers(db, row.id)
      : []

    let listener: { host: string; port: number } | null = null
    if (row?.serverId) {
      const engineCode = row.engine && isManagedEngineCode(row.engine)
        ? row.engine
        : null
      const spec = engineCode ? getManagedEngineSpec(engineCode) : null
      if (spec) {
        const parsed = parseManagedRowOptions(spec, row.options)
        if (parsed) {
          listener = await resolveManagedConnectionListener(db, {
            serverId: row.serverId,
            protocolPort: spec.defaultPort,
            exposure: parsed.settings.exposure,
          })
        }
      }
    }

    return c.json({
      status: row?.status ?? null,
      host: listener?.host ?? residual.host ?? null,
      port: listener?.port ?? residual.port ?? null,
      containers: rows.map(serializeContainerRow),
      members: memberRows.map((m) => {
        const serialized = serializeManagedMember(m, null)
        return buildStatusMemberView(serialized)
      }),
    })
  })

  router.get('/environments/:id/managed/logs', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const serverId = row.serverId
    if (!serverId) return c.json({ error: 'server_placement_required' }, 409)

    const tail = parseLogsTailQuery(c.req.query('tail'))
    const result = await fetchManagedLogs(c, db, {
      managedId: row.id,
      serverId,
      tail,
    })
    if (result instanceof Response) return result
    return c.json(result)
  })

  router.get('/environments/:id/managed/backups', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ backups: [] })

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const backups = sortManagedBackupsDesc(options.backups)
    return c.json({ backups })
  })

  router.post('/environments/:id/managed/backups', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    // Backup artifacts live on the host that actually ran the engine —
    // `managed.server_id`, not the (possibly drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const database = resolveBackupDatabase(options, body.database, ctx.spec.engine)
    if (database === null) {
      return c.json({ error: 'Invalid database' }, 400)
    }

    const built = buildManagedBackupCreatePayload(ctx, row.id, options, database)
    if (isManagedBackupApiError(built)) return mapManagedBackupApiError(c, built)

    const enqueued = await enqueueManagedBackup(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      payload: built.payload,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json({
      ok: true,
      backupId: built.backupId,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.delete('/environments/:id/managed/backups/:backupId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const backupId = decodeURIComponent(c.req.param('backupId'))
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const record: ManagedBackupRecord | undefined = findManagedBackupById(
      options.backups,
      backupId,
    )
    if (!record) return c.json({ error: 'backup_not_found' }, 404)

    // Backup artifacts live on the host that actually ran the engine —
    // `managed.server_id`, not the (possibly drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const built = buildManagedBackupDeletePayload(ctx, row.id, record)
    if (isManagedBackupApiError(built)) return mapManagedBackupApiError(c, built)

    const enqueued = await enqueueManagedBackup(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      payload: built.payload,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json({
      ok: true,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.post('/environments/:id/managed/backups/:backupId/restore', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const environmentId = c.req.param('id')
    const backupId = decodeURIComponent(c.req.param('backupId'))
    const auth = await authorizeManagedRequest(c, db, environmentId, 'manage')
    if (auth instanceof Response) return auth

    const ctx = await loadManagedContext(c, db, environmentId, auth.organizationId)
    if (ctx instanceof Response) return ctx

    const row = await findManagedForEnvironment(db, environmentId)
    if (!row) return c.json({ error: 'Not found' }, 404)

    const options = parseManagedRowOptions(ctx.spec, row.options)
    if (!options) return c.json({ error: 'Invalid managed options' }, 400)

    const record: ManagedBackupRecord | undefined = findManagedBackupById(
      options.backups,
      backupId,
    )
    if (!record) return c.json({ error: 'backup_not_found' }, 404)

    // Restore must run on the host that actually owns the engine —
    // `managed.server_id`, not the (possibly drifted) environment placement.
    const targetServerId = resolveManagedTargetServerId(c, row.serverId)
    if (targetServerId instanceof Response) return targetServerId

    const busy = assertManagedNotBusy(c, row.status)
    if (busy) return busy

    const offline = await assertTargetServerOnline(c, db, targetServerId)
    if (offline) return offline

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const built = buildManagedRestorePayload(ctx, row.id, record)
    if (isManagedBackupApiError(built)) return mapManagedBackupApiError(c, built)

    const enqueued = await enqueueManagedRestore(c, db, commandQueue, {
      serverId: targetServerId,
      userId: auth.userId,
      managedId: row.id,
      payload: built.payload,
    })
    if (enqueued instanceof Response) return enqueued

    return c.json({
      ok: true,
      commandId: enqueued.commandId,
      serverId: enqueued.serverId,
    })
  })

  router.get('/organizations/:id/managed', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const organizationId = c.req.param('id')
    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    if (orgResult !== organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanManageOr403(c, 'organization', organizationId)
    if (denied) return denied

    const rows = await db
      .select({
        id: managed.id,
        environmentId: managed.environmentId,
        displayName: managed.name,
        engine: managed.engine,
        status: managed.status,
        metadata: managed.metadata,
        options: managed.options,
        serverId: managed.serverId,
        createdAt: managed.createdAt,
        updatedAt: managed.updatedAt,
        environmentDisplayName: environment.name,
        projectId: project.id,
        projectDisplayName: project.name,
        workspaceId: workspace.id,
        workspaceDisplayName: workspace.name,
        serverDisplayName: server.name,
      })
      .from(managed)
      .innerJoin(environment, eq(managed.environmentId, environment.id))
      .innerJoin(project, eq(environment.projectId, project.id))
      .innerJoin(workspace, eq(project.workspaceId, workspace.id))
      .leftJoin(server, eq(managed.serverId, server.id))
      .where(eq(workspace.organizationId, organizationId))
      .orderBy(desc(managed.createdAt))

    const memberRows = await listManagedMembersForManagedIds(
      db,
      rows.map((r) => r.id),
    )
    const membersByManaged = new Map<string, typeof memberRows>()
    for (const member of memberRows) {
      const list = membersByManaged.get(member.managedId) ?? []
      list.push(member)
      membersByManaged.set(member.managedId, list)
    }

    const serverIds = [...new Set(memberRows.map((m) => m.serverId))]
    const serverNames = serverIds.length === 0
      ? []
      : await db
        .select({ id: server.id, name: server.name })
        .from(server)
        .where(inArray(server.id, serverIds))
    const nameByServer = new Map(serverNames.map((s) => [s.id, s.name]))

    return c.json({
      managed: rows.map((row) => {
        const spec = row.engine ? getManagedEngineSpec(row.engine) : null
        const members = (membersByManaged.get(row.id) ?? []).map((m) =>
          serializeManagedMember(m, nameByServer.get(m.serverId) ?? null),
        )
        return buildOrgManagedListEntry({
          serializedRow: serializeManagedRow(row, row.serverId) as Record<
            string,
            unknown
          >,
          engineDisplayName: spec?.displayName ?? null,
          environmentDisplayName: row.environmentDisplayName,
          projectId: row.projectId,
          projectDisplayName: row.projectDisplayName,
          workspaceId: row.workspaceId,
          workspaceDisplayName: row.workspaceDisplayName,
          serverDisplayName: row.serverDisplayName,
          members,
        })
      }),
    })
  })
}
