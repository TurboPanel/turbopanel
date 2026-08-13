import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanManageOr403, parseJsonBody } from '../shared.ts'
import { getDb } from '../../db.ts'
import { organization } from '../../lib/db/schema.ts'
import { assertDispatchInfrastructure } from '../servers/command-dispatch.ts'
import {
  disableOrganizationFabric,
  enableOrganizationFabric,
  getOrganizationFabric,
  listFabricRelays,
  type FabricRecord,
} from '../../lib/db/fabric-records.ts'
import { enqueueFabricReconcileForServers } from '../../lib/fabric/enqueue.ts'
import {
  fabricSettingsResponse,
  parseFabricPutBody,
} from './fabric-routes-helpers.ts'

function fabricEnableErrorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('No free CIDR')) {
    return Response.json({ error: 'fabric_cidr_unavailable' }, { status: 409 })
  }
  if (message.includes('address pool exhausted')) {
    return Response.json({ error: 'fabric_address_pool_exhausted' }, { status: 409 })
  }
  return Response.json({ error: 'TurboFabric update failed' }, { status: 500 })
}

export function registerOrganizationFabricRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  router.use('/organizations/:id/fabric', createSessionMiddleware(opts.secrets))

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
    return c.json(fabricSettingsResponse(record))
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
      })
      await disableOrganizationFabric(db, id)
      return c.json(fabricSettingsResponse(null))
    }

    let record: FabricRecord
    try {
      record = await enableOrganizationFabric(db, id)
    } catch (err) {
      return fabricEnableErrorResponse(err)
    }
    const relays = await listFabricRelays(db, record.id)
    await enqueueFabricReconcileForServers({
      db,
      commandQueue,
      actorType: 'user',
      actorId: session.userId,
      fabric: record,
      serverIds: relays.map((row) => row.serverId),
      enabled: true,
    })
    return c.json(fabricSettingsResponse(record))
  })
}
