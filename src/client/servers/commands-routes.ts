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
import { getDb, type Db } from '../../db.ts'
import {
  getCommandRecord,
  listServerCommands,
} from '../../lib/db/command-records.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { createAndEnqueueUserCommand } from './command-dispatch.ts'
import {
  parseHostnameCommandBody,
  parseTimezoneCommandBody,
  parseNtpCommandBody,
  shapeCommandGetResponse,
  commandNotFoundOnServer,
} from './commands-routes-helpers.ts'

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
  router.use('/servers/:id/commands/*', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/hostname', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/timezone', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/ntp', createSessionMiddleware(opts.secrets))

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
