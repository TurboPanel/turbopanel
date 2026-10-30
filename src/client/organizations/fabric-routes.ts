import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { type Db, getDaemonCellRegistry, getDb } from '../../db/connection.ts'
import { organization } from '../../db/schema.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import {
  assertGatewayRelaysReady,
  loadDatacenterSubnetsForServers,
  resolveDerivedAdvertisedCidrsByRelay,
} from '../../features/net/datacenter-networks.ts'
import {
  enableOrganizationFabric,
  FabricContainerPoolOverlapError,
  type FabricEnablePolicy,
  type FabricRecord,
  getOrganizationFabric,
  listFabricRelays,
  listSubnetsForServers,
  loadEndpointCaches,
  loadRelayPresharedKeyPresence,
  type RelayRecord,
  updateFabricRelay,
} from '../../features/fabric/fabric-records.ts'
import { parseFabricPolicy } from '../../features/fabric/policy.ts'
import { checkAdvertisedRangesAgainstPool } from '../../features/fabric/advertised-ranges.ts'
import { loadResolvedGatewayRanges } from '../../features/fabric/gateway-ranges.ts'
import {
  findCidrCollision,
  loadOrganizationCidrRegistry,
} from '../../features/net/cidr-collisions.ts'
import { cidrContains } from '../../lib/ip-address.ts'
import { cidrCollisionResponse } from '../networks/network-scope.ts'
import { reconcileFabricMembership } from '../../features/fabric/enqueue.ts'
import { loadFabricServerMemberships } from '../../features/fabric/membership.ts'
import { applyServerFabricPatch, pauseFabric, removeFabric } from './fabric-lifecycle.ts'
import {
  advertisedRangeProblemResponse,
  bindSecretEncryptFn,
  enqueueRelayPatchReconcile,
  fabricEnableErrorResponse,
  type FabricMembershipSecrets,
  fabricNotEnabledErrorResponse,
  type FabricPutBody,
  type FabricRelayApiRow,
  fabricSettingsResponse,
  fabricTypedEnqueueErrorResponse,
  findByServerId,
  gatewayRangePatchErrorResponse,
  gatewayRolePatchErrorResponse,
  parseFabricPutBody,
  parseFabricServerPatchBody,
  parseRelayPatchBody,
  preferredGatewayPatchErrorResponse,
  relayPatchUpdateFields,
  resolveSealedRelayPresharedKey,
  toFabricRelayApiRow,
} from './fabric-routes-helpers.ts'

/**
 * Validate a replacement `fabric.options.containerPool` before anything is
 * written:
 *
 * 1. the candidate goes through the org CIDR collision authority with the
 *    *current* pool excluded (a narrowed or re-based pool always overlaps
 *    the one it replaces) — 409 via `cidrCollisionResponse`;
 * 2. every allocated relay prefix must still sit inside the new pool.
 *    Nothing renumbers relays, so a pool that orphans one is refused
 *    (409 `fabric_container_pool_in_use`) rather than silently accepted;
 * 3. no range a gateway advertises may sit inside the new pool (400
 *    `gateway_range_overlaps_fabric_pool`).
 */
async function assertContainerPoolWritable(
  c: Context,
  db: Db,
  organizationId: string,
  containerPool: string,
  existing: FabricRecord | null
): Promise<Response | null> {
  const registry = await loadOrganizationCidrRegistry(db, organizationId)
  const collision = findCidrCollision(
    { ...registry, containerPool: null },
    { cidr: containerPool, intent: 'docker' }
  )
  if (collision) return cidrCollisionResponse(c, collision)
  if (!existing) return null
  const relays = await listFabricRelays(db, existing.id)
  const orphaned = relays.find((row) => !cidrContains(containerPool, row.prefix))
  if (orphaned) {
    return c.json(
      {
        error: 'fabric_container_pool_in_use',
        containerPool,
        prefix: orphaned.prefix,
        serverId: orphaned.serverId,
      },
      409
    )
  }
  return gatewayRangesInPoolResponse(db, containerPool, relays)
}

/**
 * A wider or moved pool must not swallow a range a gateway already advertises
 * (the daemon would refuse every host's peers). Only the pool is checked here;
 * the other range rules are enforced where the ranges are written.
 */
async function gatewayRangesInPoolResponse(
  db: Db,
  containerPool: string,
  relays: readonly RelayRecord[]
): Promise<Response | null> {
  const resolved = await loadResolvedGatewayRanges(db, relays)
  const problem = checkAdvertisedRangesAgainstPool([...resolved.values()].flat(), containerPool)
  return problem ? advertisedRangeProblemResponse(problem) : null
}

function fabricSecretsFromContext(c: {
  get: (key: 'secretsConfig' | 'dataEncryptionSecrets') => unknown
}): FabricMembershipSecrets {
  const secretsConfig = c.get('secretsConfig') as FabricMembershipSecrets['secretsConfig']
  const dataEncryptionSecrets = c.get(
    'dataEncryptionSecrets'
  ) as FabricMembershipSecrets['dataEncryptionSecrets']
  return {
    ...(secretsConfig ? { secretsConfig } : {}),
    ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}),
  }
}

/** The GET body: settings, relays and every server's membership. */
async function fabricSettingsBody(
  db: Db,
  organizationId: string
): Promise<ReturnType<typeof fabricSettingsResponse>> {
  const record = await getOrganizationFabric(db, organizationId)
  const relays = record ? await listFabricRelays(db, record.id) : []
  const servers = await loadFabricServerMemberships(db, { organizationId, relays })
  if (!record) return fabricSettingsResponse(null, [], servers)
  return fabricSettingsResponse(
    record,
    await loadFabricRelayApiRows(db, relays, parseFabricPolicy(record.options).allowRelay),
    servers
  )
}

type BodyParser<T> = (body: unknown) => ({ ok: true } & T) | { ok: false; error: string }

/**
 * Shared preamble for the mutating routes, in the order every route answers:
 * db, manage permission, body (400), org (404), session, command queue.
 */
async function mutatingFabricContext<T>(
  c: Context<AppEnv>,
  parse: BodyParser<T> | null
): Promise<
  | Response
  | {
      db: Db
      organizationId: string
      parsed: T | null
      actorId: string
      commandQueue: CommandQueue
    }
> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)
  const organizationId = c.req.param('id') ?? ''
  const denied = await assertCanManageOr403(c, 'organization', organizationId)
  if (denied) return denied
  let parsed: T | null = null
  if (parse) {
    const body = await parseJsonBody(c)
    if (body instanceof Response) return body
    const result = parse(body)
    if (!result.ok) return c.json({ error: result.error }, 400)
    parsed = result
  }
  const [orgRow] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  if (!orgRow) return c.json({ error: 'Not found' }, 404)
  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  const commandQueue = assertDispatchInfrastructure(c)
  if (commandQueue instanceof Response) return commandQueue
  return { db, organizationId, parsed, actorId: session.userId, commandQueue }
}

/** Refuse a requested container pool that cannot be written; null when none was asked for or it is fine. */
async function containerPoolDenial(
  c: Context,
  db: Db,
  organizationId: string,
  containerPool: string | undefined
): Promise<Response | null> {
  if (containerPool === undefined) return null
  return assertContainerPoolWritable(
    c,
    db,
    organizationId,
    containerPool,
    await getOrganizationFabric(db, organizationId)
  )
}

function fabricEnablePolicyFromBody(parsed: FabricPutBody): FabricEnablePolicy {
  return {
    ...(parsed.allowRelay === undefined ? {} : { allowRelay: parsed.allowRelay }),
    ...(parsed.containerPool === undefined ? {} : { containerPool: parsed.containerPool }),
  }
}

/**
 * Enable (or re-policy) the fabric, mapping the typed enable failures onto
 * their HTTP responses. A first-time enable picks the tp0 host range before
 * anything is written; a pool that range lands in is refused with nothing
 * enabled.
 */
async function enableOrganizationFabricOrResponse(
  c: Context,
  db: Db,
  organizationId: string,
  policy: FabricEnablePolicy
): Promise<FabricRecord | Response> {
  try {
    return await enableOrganizationFabric(db, organizationId, policy)
  } catch (err) {
    if (err instanceof FabricContainerPoolOverlapError) {
      return cidrCollisionResponse(c, {
        code: 'cidr_overlaps_fabric',
        cidr: err.containerPool,
        conflictingCidr: err.fabricCidr,
        networkId: null,
        datacenterId: null,
      })
    }
    return fabricEnableErrorResponse(err)
  }
}

async function loadFabricRelayApiRows(
  db: Parameters<typeof listFabricRelays>[0],
  relays: RelayRecord[],
  orgAllowRelay: boolean
): Promise<FabricRelayApiRow[]> {
  const serverIds = relays.map((row) => row.serverId)
  const [{ caches }, segmentsByServer, pskPresence, subnetsByServer] = await Promise.all([
    loadEndpointCaches(db, serverIds),
    listSubnetsForServers(db, serverIds),
    loadRelayPresharedKeyPresence(
      db,
      relays.map((row) => row.id)
    ),
    loadDatacenterSubnetsForServers(db, serverIds),
  ])
  const derivedByRelayId = resolveDerivedAdvertisedCidrsByRelay(relays, subnetsByServer)
  return relays.map((row) =>
    toFabricRelayApiRow({
      relay: row,
      hasPresharedKey: pskPresence.has(row.id),
      segments: segmentsByServer.get(row.serverId) ?? [],
      caches,
      relays,
      resolvedAdvertisedCidrs: derivedByRelayId.get(row.id) ?? [],
      orgAllowRelay,
    })
  )
}

export function registerOrganizationFabricRoutes(router: Hono<AppEnv>, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for fabric routes')
  }
  const secrets = opts.secrets

  router.use('/organizations/:id/fabric', createSessionMiddleware(secrets))
  router.use('/organizations/:id/fabric/relays/:serverId', createSessionMiddleware(secrets))
  router.use('/organizations/:id/fabric/apply', createSessionMiddleware(secrets))
  router.use('/organizations/:id/fabric/servers/:serverId', createSessionMiddleware(secrets))

  router.get('/organizations/:id/fabric', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    return c.json(await fabricSettingsBody(db, id))
  })

  // Remove TurboFabric completely: tear down every server, delete keys,
  // cross-server container networks and the fabric row.
  router.delete('/organizations/:id/fabric', async (c) => {
    const ctx = await mutatingFabricContext(c, null)
    if (ctx instanceof Response) return ctx
    const refused = await removeFabric(c, { ...ctx, secrets: fabricSecretsFromContext(c) })
    if (refused) return refused
    return c.json(await fabricSettingsBody(ctx.db, ctx.organizationId))
  })

  // One server's membership switch and role (`null` role = automatic).
  router.patch('/organizations/:id/fabric/servers/:serverId', async (c) => {
    const ctx = await mutatingFabricContext(c, parseFabricServerPatchBody)
    if (ctx instanceof Response) return ctx
    const patch = ctx.parsed?.patch ?? {}
    const serverId = c.req.param('serverId')
    const [current] = await loadFabricServerMemberships(ctx.db, {
      organizationId: ctx.organizationId,
      relays: [],
      serverId,
    })
    if (!current) return c.json({ error: 'Not found' }, 404)
    const refused = await applyServerFabricPatch(c, {
      ...ctx,
      secrets: fabricSecretsFromContext(c),
      serverId,
      serverName: current.name,
      currentlyEnabled: current.enabled,
      patch,
    })
    if (refused) return refused
    const body = await fabricSettingsBody(ctx.db, ctx.organizationId)
    const server = body.servers.find((row) => row.serverId === serverId)
    return c.json({ ok: true, server })
  })

  router.patch('/organizations/:id/fabric/relays/:serverId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const serverId = c.req.param('serverId')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseRelayPatchBody(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const record = await getOrganizationFabric(db, id)
    if (!record) return fabricNotEnabledErrorResponse()

    const fabricRelays = await listFabricRelays(db, record.id)
    const existing = findByServerId(fabricRelays, serverId)
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const role = parsed.patch.role ?? existing.role
    const gatewayDenied = gatewayRolePatchErrorResponse(
      role,
      await assertGatewayRelaysReady(db, [{ serverId, role }])
    )
    if (gatewayDenied) return gatewayDenied

    const rangeDenied = await gatewayRangePatchErrorResponse(db, {
      patch: parsed.patch,
      existing,
      record,
      relays: fabricRelays,
    })
    if (rangeDenied) return rangeDenied

    const preferredDenied = preferredGatewayPatchErrorResponse(parsed.patch, fabricRelays, serverId)
    if (preferredDenied) return preferredDenied

    const sealedPresharedKey = await resolveSealedRelayPresharedKey(
      parsed.patch.presharedKey,
      bindSecretEncryptFn(c.get('dataEncryptionSecrets'), encryptSecret)
    )
    const updated = await updateFabricRelay(db, {
      fabricId: record.id,
      serverId,
      ...relayPatchUpdateFields(parsed.patch, sealedPresharedKey),
    })
    if (!updated) return c.json({ error: 'Not found' }, 404)

    const enqueueDenied = await enqueueRelayPatchReconcile({
      session: c.get('session'),
      commandQueue: assertDispatchInfrastructure(c),
      db,
      organizationId: id,
      secrets: fabricSecretsFromContext(c),
      reconcile: reconcileFabricMembership,
    })
    if (enqueueDenied) return enqueueDenied

    const relays = await listFabricRelays(db, record.id)
    const row = findByServerId(
      await loadFabricRelayApiRows(db, relays, parseFabricPolicy(record.options).allowRelay),
      serverId
    )
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({ ok: true, relay: row })
  })

  router.post('/organizations/:id/fabric/apply', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const record = await getOrganizationFabric(db, id)
    if (!record) return fabricNotEnabledErrorResponse()

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const results = await reconcileFabricMembership({
      db,
      commandQueue,
      actorType: 'user',
      actorId: session.userId,
      organizationId: id,
      force: true,
      registry: getDaemonCellRegistry(c),
      ...fabricSecretsFromContext(c),
    })
    const enqueueDenied = fabricTypedEnqueueErrorResponse(results)
    if (enqueueDenied) return enqueueDenied

    return c.json({
      ok: true,
      fabricId: record.id,
      interfaceName: 'tp0',
      results: results.map((row) => ({
        serverId: row.serverId,
        status: row.status,
        ...(row.commandId ? { commandId: row.commandId } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.unreachablePeers && row.unreachablePeers.length > 0
          ? { unreachablePeers: row.unreachablePeers }
          : {}),
        ...(row.gatewayRoutedPeers && row.gatewayRoutedPeers.length > 0
          ? { gatewayRoutedPeers: row.gatewayRoutedPeers }
          : {}),
        ...(row.natCandidates && row.natCandidates > 0 ? { natCandidates: row.natCandidates } : {}),
        ...(row.degradedPeers && row.degradedPeers > 0 ? { degradedPeers: row.degradedPeers } : {}),
      })),
    })
  })

  router.put('/organizations/:id/fabric', async (c) => {
    const ctx = await mutatingFabricContext(c, parseFabricPutBody)
    if (ctx instanceof Response) return ctx
    const parsed = ctx.parsed
    if (!parsed) return c.json({ error: 'Invalid request' }, 400)

    const { db, commandQueue, organizationId: id } = ctx
    const secrets = fabricSecretsFromContext(c)

    if (!parsed.enabled) {
      // Turning TurboFabric off pauses it and keeps the keys; removing it
      // completely is DELETE.
      const refused = await pauseFabric(c, { ...ctx, secrets })
      if (refused) return refused
      return c.json(await fabricSettingsBody(db, id))
    }

    const poolDenied = await containerPoolDenial(c, db, id, parsed.containerPool)
    if (poolDenied) return poolDenied

    // The policy rides along with the enable so relay prefixes are carved
    // from the requested pool (never the default) and the fabric row, policy
    // and relays land — or roll back — together.
    const policy = fabricEnablePolicyFromBody(parsed)
    const record = await enableOrganizationFabricOrResponse(c, db, id, policy)
    if (record instanceof Response) return record
    const enqueueResults = await reconcileFabricMembership({
      db,
      commandQueue,
      actorType: 'user',
      actorId: ctx.actorId,
      organizationId: id,
      registry: getDaemonCellRegistry(c),
      ...secrets,
    })
    const enqueueDenied = fabricTypedEnqueueErrorResponse(enqueueResults)
    if (enqueueDenied) return enqueueDenied
    return c.json(await fabricSettingsBody(db, id))
  })
}
