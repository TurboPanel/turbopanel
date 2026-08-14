import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { getDb } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import { assertGatewayRelaysReady } from '../../lib/net/datacenter-networks.ts'
import {
  disableOrganizationFabric,
  enableOrganizationFabric,
  type FabricRecord,
  getOrganizationFabric,
  listFabricRelays,
  listSegmentsForServers,
  loadEndpointCaches,
  loadRelayPresharedKeyPresence,
  purgeOrganizationComposeNetworks,
  type RelayRecord,
  updateFabricRelay,
} from '../../lib/db/fabric-records.ts'
import {
  enqueueFabricReconcileForServers,
  reconcileFabricMembership,
} from '../../lib/fabric/enqueue.ts'
import {
  enqueueRelayPatchReconcile,
  type FabricMembershipSecrets,
  type FabricRelayApiRow,
  fabricEnableErrorResponse,
  fabricNotEnabledErrorResponse,
  fabricSettingsResponse,
  fabricTypedEnqueueErrorResponse,
  gatewayRolePatchErrorResponse,
  parseFabricPutBody,
  parseRelayPatchBody,
  relayPatchUpdateFields,
  resolveSealedRelayPresharedKey,
  toFabricRelayApiRow,
} from './fabric-routes-helpers.ts'

function fabricSecretsFromContext(c: {
  get: (key: 'secretsConfig' | 'dataEncryptionSecrets') => unknown
}): FabricMembershipSecrets {
  const secretsConfig = c.get(
    'secretsConfig',
  ) as FabricMembershipSecrets['secretsConfig']
  const dataEncryptionSecrets = c.get(
    'dataEncryptionSecrets',
  ) as FabricMembershipSecrets['dataEncryptionSecrets']
  return {
    ...(secretsConfig ? { secretsConfig } : {}),
    ...(dataEncryptionSecrets ? { dataEncryptionSecrets } : {}),
  }
}

async function loadFabricRelayApiRows(
  db: Parameters<typeof listFabricRelays>[0],
  relays: RelayRecord[],
): Promise<FabricRelayApiRow[]> {
  const serverIds = relays.map((row) => row.serverId)
  const [{ caches }, segmentsByServer, pskPresence] = await Promise.all([
    loadEndpointCaches(db, serverIds),
    listSegmentsForServers(db, serverIds),
    loadRelayPresharedKeyPresence(db, relays.map((row) => row.id)),
  ])
  return relays.map((row) =>
    toFabricRelayApiRow({
      relay: row,
      hasPresharedKey: pskPresence.has(row.id),
      segments: segmentsByServer.get(row.serverId) ?? [],
      caches,
      relays,
    })
  )
}

export function registerOrganizationFabricRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  router.use('/organizations/:id/fabric', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/fabric/relays/:serverId', createSessionMiddleware(opts.secrets))
  router.use('/organizations/:id/fabric/apply', createSessionMiddleware(opts.secrets))

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

    const record = await getOrganizationFabric(db, id)
    if (!record) return c.json(fabricSettingsResponse(null))
    const relays = await listFabricRelays(db, record.id)
    return c.json(
      fabricSettingsResponse(record, await loadFabricRelayApiRows(db, relays)),
    )
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

    const existing = (await listFabricRelays(db, record.id)).find((row) =>
      row.serverId === serverId
    )
    if (!existing) return c.json({ error: 'Not found' }, 404)

    const role = parsed.patch.role ?? existing.role
    const gatewayDenied = gatewayRolePatchErrorResponse(
      role,
      await assertGatewayRelaysReady(db, [{ serverId, role }]),
    )
    if (gatewayDenied) return gatewayDenied

    const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
    const sealedPresharedKey = await resolveSealedRelayPresharedKey(
      parsed.patch.presharedKey,
      dataEncryptionSecrets
        ? (plaintext) => encryptSecret(dataEncryptionSecrets, plaintext)
        : null,
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
    const row = (await loadFabricRelayApiRows(db, relays)).find((entry) =>
      entry.serverId === serverId
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
      })),
    })
  })

  router.put('/organizations/:id/fabric', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'organization', id)
    if (denied) return denied

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseFabricPutBody(body)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, id))
      .limit(1)
    if (!orgRow) return c.json({ error: 'Not found' }, 404)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const secrets = fabricSecretsFromContext(c)

    if (!parsed.enabled) {
      const existing = await getOrganizationFabric(db, id)
      if (!existing) return c.json(fabricSettingsResponse(null))
      const relays = await listFabricRelays(db, existing.id)
      await enqueueFabricReconcileForServers({
        db,
        commandQueue,
        actorType: 'user',
        actorId: session.userId,
        fabric: existing,
        serverIds: relays.map((row) => row.serverId),
        enabled: false,
        ...secrets,
      })
      await db.transaction(async (tx) => {
        await purgeOrganizationComposeNetworks(tx, id)
        await disableOrganizationFabric(tx, id)
      })
      return c.json(fabricSettingsResponse(null))
    }

    let record: FabricRecord
    try {
      record = await enableOrganizationFabric(db, id)
    } catch (err) {
      return fabricEnableErrorResponse(err)
    }
    const enqueueResults = await reconcileFabricMembership({
      db,
      commandQueue,
      actorType: 'user',
      actorId: session.userId,
      organizationId: id,
      ...secrets,
    })
    const enqueueDenied = fabricTypedEnqueueErrorResponse(enqueueResults)
    if (enqueueDenied) return enqueueDenied
    const relays = await listFabricRelays(db, record.id)
    return c.json(
      fabricSettingsResponse(record, await loadFabricRelayApiRows(db, relays)),
    )
  })
}
