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
import { assertValidHostname } from '../../lib/commands/hostname.ts'
import {
  parseNtpSetPayload,
  parsePingResult,
  parseTimezoneSetPayload,
} from '../../lib/commands/schemas.ts'
import {
  getCommandRecord,
  listServerCommands,
  type CommandRecord,
} from '../../lib/db/command-records.ts'
import { isAllowedTimezone } from '../../lib/timezones.ts'
import { verifyServerInOrg } from '../environments/deploy-prepare.ts'
import { createAndEnqueueUserCommand } from './command-dispatch.ts'

type PingLatencyBreakdown = {
  apiToConsumerMs: number | null
  consumerToCellMs: number | null
  cellToDaemonMs: number | null
  daemonProcessingMs: number | null
  daemonToRecordedMs: number | null
  totalRoundTripMs: number | null
}

type ServerCommandAccess = {
  db: Db
  serverId: string
  userId: string
}

function diffMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null
  return Date.parse(end) - Date.parse(start)
}

/** Clamp negative deltas (clock skew) to zero for display-safe hop timings. */
function nonNegativeDiffMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const ms = diffMs(start, end)
  if (ms === null) return null
  return Math.max(0, ms)
}

function computePingLatency(record: CommandRecord): PingLatencyBreakdown {
  const pingResult = parsePingResult(record.result)
  const cellDispatchedAt = pingResult.cellDispatchedAt ?? record.sentAt
  const cellAckAt = record.ackedAt ?? record.finishedAt
  return {
    apiToConsumerMs: diffMs(record.queuedAt, record.dispatchStartedAt),
    consumerToCellMs: diffMs(record.dispatchStartedAt, cellDispatchedAt),
    cellToDaemonMs: nonNegativeDiffMs(cellDispatchedAt, cellAckAt),
    daemonProcessingMs: nonNegativeDiffMs(
      pingResult.daemonReceivedAt,
      pingResult.daemonRespondedAt,
    ),
    daemonToRecordedMs: record.ackedAt
      ? nonNegativeDiffMs(record.ackedAt, record.finishedAt)
      : nonNegativeDiffMs(cellDispatchedAt, record.finishedAt),
    totalRoundTripMs: diffMs(record.queuedAt, record.finishedAt),
  }
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

export function registerServerCommandRoutes(router: Hono, opts: AuthRouteOpts) {
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

    const hostname = body.hostname
    if (typeof hostname !== 'string' || hostname.length === 0) {
      return c.json({ error: 'Invalid request' }, 400)
    }

    try {
      assertValidHostname(hostname)
    } catch {
      return c.json({ error: 'Invalid hostname' }, 400)
    }

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'server.hostname.set',
      payload: { hostname },
      ttlMs: 300_000,
    })
  })

  router.post('/servers/:id/timezone', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'manage')
    if (access instanceof Response) return access

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let payload
    try {
      payload = parseTimezoneSetPayload(body)
    } catch {
      return c.json({ error: 'Invalid timezone' }, 400)
    }
    if (!isAllowedTimezone(payload.timezone)) {
      return c.json({ error: 'Invalid timezone' }, 400)
    }

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'server.timezone.set',
      payload,
      ttlMs: 300_000,
    })
  })

  router.post('/servers/:id/ntp', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'manage')
    if (access instanceof Response) return access

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let payload
    try {
      payload = parseNtpSetPayload(body)
    } catch {
      return c.json({ error: 'Invalid ntp payload' }, 400)
    }

    return createAndEnqueueUserCommand(c, access.db, {
      serverId: access.serverId,
      actorId: access.userId,
      type: 'server.ntp.set',
      payload,
      ttlMs: 300_000,
    })
  })

  router.get('/servers/:id/commands/:commandId', async (c) => {
    const access = await resolveServerCommandAccess(c, c.req.param('id'), 'read')
    if (access instanceof Response) return access

    const commandId = c.req.param('commandId')
    const record = await getCommandRecord(access.db, commandId)
    if (record?.serverId !== access.serverId) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (record.type === 'daemon.ping') {
      return c.json({ ...record, latency: computePingLatency(record) })
    }

    return c.json(record)
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
