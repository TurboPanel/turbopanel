import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import { assertCanOr403 } from '../authz/index.ts'
import { getDb } from '../../db.ts'
import { network, server } from '../../lib/db/schema.ts'
import { parseJsonBody } from '../shared.ts'

export function registerNetworkRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/networks', createSessionMiddleware(opts.secrets))
  router.use('/networks/:id', createSessionMiddleware(opts.secrets))

  router.get('/networks', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const serverId = c.req.query('serverId')?.trim()
    if (!serverId) {
      return c.json({ error: 'serverId query parameter is required' }, 400)
    }

    const serverRows = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)

    const organizationId = serverRows[0]?.organizationId
    if (!organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(
      c,
      'organization:manage',
      'organization',
      organizationId,
    )
    if (denied) return denied

    const rows = await db
      .select({
        id: network.id,
        serverId: network.serverId,
        createdAt: network.createdAt,
        updatedAt: network.updatedAt,
      })
      .from(network)
      .where(eq(network.serverId, serverId))
      .orderBy(network.createdAt)

    return c.json({ networks: rows })
  })

  router.post('/networks', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const serverIdRaw = body.serverId
    if (typeof serverIdRaw !== 'string' || serverIdRaw.trim().length === 0) {
      return c.json({ error: 'Invalid request' }, 400)
    }
    const serverId = serverIdRaw.trim()

    const serverRows = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)

    const organizationId = serverRows[0]?.organizationId
    if (!organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(
      c,
      'organization:manage',
      'organization',
      organizationId,
    )
    if (denied) return denied

    const [inserted] = await db
      .insert(network)
      .values({ serverId })
      .returning({ id: network.id })

    const id = inserted?.id
    if (!id) {
      return c.json({ error: 'Failed to create network' }, 500)
    }

    return c.json({ ok: true as const, id })
  })

  router.delete('/networks/:id', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const id = c.req.param('id')

    const networkRows = await db
      .select({ serverId: network.serverId })
      .from(network)
      .where(eq(network.id, id))
      .limit(1)

    const networkRow = networkRows[0]
    if (!networkRow) {
      return c.json({ error: 'Not found' }, 404)
    }

    const serverRows = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, networkRow.serverId))
      .limit(1)

    const organizationId = serverRows[0]?.organizationId
    if (!organizationId) {
      return c.json({ error: 'Not found' }, 404)
    }

    const denied = await assertCanOr403(
      c,
      'organization:manage',
      'organization',
      organizationId,
    )
    if (denied) return denied

    await db.delete(network).where(eq(network.id, id))

    return c.json({ ok: true as const })
  })
}
