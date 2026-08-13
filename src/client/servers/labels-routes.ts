import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { getDb, type Db } from '../../db.ts'
import {
  listServerLabels,
  parseServerLabelInput,
  setServerLabels,
} from '../../lib/db/label-records.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'

type ServerLabelAccess = {
  db: Db
  serverId: string
}

function toLabelPairs(
  records: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  return records.map((row) => ({ key: row.key, value: row.value }))
}

async function resolveServerLabelAccess(
  c: Context,
  serverId: string,
  access: 'read' | 'manage',
): Promise<ServerLabelAccess | Response> {
  const db = getDb(c)
  if (!db) return c.json({ error: 'Database unavailable' }, 503)

  const denied =
    access === 'manage'
      ? await assertCanManageOr403(c, 'server', serverId)
      : await assertCanReadOr403(c, 'server', serverId)
  if (denied) return denied

  const session = c.get('session')
  if (!session) return c.json({ error: 'Unauthorized' }, 401)

  const orgResult = await getOrgId(c, session.userId)
  if (orgResult instanceof Response) return orgResult

  if (!(await verifyServerInOrg(db, serverId, orgResult))) {
    return c.json({ error: 'Not found' }, 404)
  }

  return { db, serverId }
}

export function registerServerLabelRoutes(router: Hono, opts: AuthRouteOpts) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server label routes')
  }
  router.use('/servers/:id/labels', createSessionMiddleware(opts.secrets))

  router.get('/servers/:id/labels', async (c) => {
    const access = await resolveServerLabelAccess(c, c.req.param('id'), 'read')
    if (access instanceof Response) return access

    const labels = await listServerLabels(access.db, access.serverId)
    return c.json({ ok: true as const, labels: toLabelPairs(labels) })
  })

  router.put('/servers/:id/labels', async (c) => {
    const access = await resolveServerLabelAccess(c, c.req.param('id'), 'manage')
    if (access instanceof Response) return access

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseServerLabelInput(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400)
    }

    const labels = await setServerLabels(access.db, access.serverId, parsed.labels)
    return c.json({ ok: true as const, labels: toLabelPairs(labels) })
  })
}
