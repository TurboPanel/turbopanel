import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { getDb, getExecutionLogStore, type Db } from '../../db.ts'
import {
  getCommandRecord,
  listCommandRecordsByIds,
  listServerCommands,
} from '../../lib/db/command-records.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { createAndEnqueueUserCommand } from './command-dispatch.ts'
import {
  parseHostnameCommandBody,
  parseTimezoneCommandBody,
  parseNtpCommandBody,
  parseCommandStatusBody,
  parseCommandLogQuery,
  shapeCommandGetResponse,
  shapeCommandLogResponse,
  shapeCommandStatusResponse,
  commandNotFoundOnServer,
} from './commands-routes-helpers.ts'
import { listVisible } from '../authz/index.ts'

type ServerCommandAccess = {
  db: Db
  serverId: string
  userId: string
}

async function resolveServerCommandAccess(
  c: Context,
  serverId: string,
  access: 'read' | 'manage',
): Promise<ServerCommandAccess | Response> {
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

  return { db, serverId, userId: session.userId }
}

export function registerServerCommandRoutes(
  router: Hono<AppEnv>,
  opts: AuthRouteOpts,
) {
  if (!opts.secrets) {
    throw new TypeError('session secrets are required for server command routes')
  }
  const secrets = opts.secrets

  router.use('/commands/status', createSessionMiddleware(secrets))
  router.use('/servers/:id/commands/*', createSessionMiddleware(secrets))
  router.use('/servers/:id/hostname', createSessionMiddleware(secrets))
  router.use('/servers/:id/timezone', createSessionMiddleware(secrets))
  router.use('/servers/:id/ntp', createSessionMiddleware(secrets))

  /**
   * Batched lean status for tracked commands — one request instead of one per
   * command id. Ids the session cannot see are silently dropped (never 403),
   * so one org's ids cannot probe another's. Never reads `dispatch`.
   */
  router.post('/commands/status', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseCommandStatusBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult

    const records = await listCommandRecordsByIds(db, parsed.ids)
    if (records.length === 0) {
      return c.json({ ok: true, commands: [] })
    }

    // One authz round-trip for the whole batch, then intersect.
    const visibleIds = new Set(
      await listVisible(db, {
        kind: 'server',
        userId: session.userId,
        organizationId: orgResult,
      }),
    )

    const visible = records.filter((record) => visibleIds.has(record.serverId))

    // Transcript existence is store-side, not a column — resolve it per id in
    // parallel. Fan-out is bounded by COMMAND_STATUS_BATCH_LIMIT (100).
    const store = getExecutionLogStore(c)
    const hasLogs = store
      ? await Promise.all(
          visible.map((record) => store.exists(record.id).catch(() => false))
        )
      : visible.map(() => false)

    const commands = visible.map((record, index) =>
      shapeCommandStatusResponse(record, hasLogs[index])
    )

    return c.json({ ok: true, commands })
  })

  router.post('/servers/:id/commands/ping', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'read')
    if (access instanceof Response) return access

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'daemon.ping',
      payload: {},
      ttlMs: 60_000,
    })
  })

  router.post('/servers/:id/commands/reboot', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'manage')
    if (access instanceof Response) return access

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'server.reboot',
      payload: {},
      ttlMs: 120_000,
    })
  })

  router.post('/servers/:id/hostname', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'manage')
    if (access instanceof Response) return access

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseHostnameCommandBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'server.hostname.set',
      payload: { hostname: parsed.hostname },
      ttlMs: 300_000,
    })
  })

  router.post('/servers/:id/timezone', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'manage')
    if (access instanceof Response) return access

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseTimezoneCommandBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'server.timezone.set',
      payload: parsed.payload,
      ttlMs: 300_000,
    })
  })

  router.post('/servers/:id/ntp', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'manage')
    if (access instanceof Response) return access

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    const parsed = parseNtpCommandBody(body)
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status)
    }

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'server.ntp.set',
      payload: parsed.payload,
      ttlMs: 300_000,
    })
  })

  router.get('/servers/:id/commands/:commandId', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'read')
    if (access instanceof Response) return access

    const commandId = c.req.param('commandId')
    const record = await getCommandRecord(access.db, commandId)
    if (commandNotFoundOnServer(record, access.serverId)) {
      return c.json({ error: 'Not found' }, 404)
    }

    return c.json(shapeCommandGetResponse(record!))
  })

  /**
   * Command transcript tail. Poll with the previous response's `nextSeq` as
   * `from`. A command with no transcript yet returns an empty body with
   * `exists: false` rather than 404, so the client poll loop stays uniform.
   */
  router.get('/servers/:id/commands/:commandId/log', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'read')
    if (access instanceof Response) return access

    const commandId = c.req.param('commandId')
    const record = await getCommandRecord(access.db, commandId)
    if (commandNotFoundOnServer(record, access.serverId)) {
      return c.json({ error: 'Not found' }, 404)
    }

    const query = parseCommandLogQuery(c.req.query('from'), c.req.query('max'))
    const store = getExecutionLogStore(c)
    if (!store) {
      return c.json(shapeCommandLogResponse(null, query.from))
    }

    const result = await store.readFrom(commandId, query.from, query.max)
    return c.json(shapeCommandLogResponse(result, query.from))
  })

  router.get('/servers/:id/commands', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'read')
    if (access instanceof Response) return access

    const commands = await listServerCommands(access.db, {
      serverId: access.serverId,
      limit: 20,
    })

    return c.json({ ok: true, commands })
  })
}
