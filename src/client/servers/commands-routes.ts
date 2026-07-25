import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { getDb } from '../../db.ts'
import { assertValidHostname } from '../../lib/commands/hostname.ts'
import {
  parseNtpSetPayload,
  parsePingResult,
  parseTimezoneSetPayload,
} from '../../lib/commands/schemas.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import {
  createCommandRecord,
  getCommandRecord,
  listServerCommands,
  type CommandRecord,
} from '../../lib/db/command-records.ts'
import { isAllowedTimezone } from '../../lib/timezones.ts'
import { server } from '../../lib/db/schema.ts'
import {
  assertDispatchInfrastructure,
  enqueueCommandOrCompensate,
} from './command-dispatch.ts'

type PingLatencyBreakdown = {
  apiToConsumerMs: number | null
  consumerToCellMs: number | null
  cellToDaemonMs: number | null
  daemonProcessingMs: number | null
  daemonToRecordedMs: number | null
  totalRoundTripMs: number | null
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
  const latency = {
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
  return latency
}

async function verifyServerInOrg(
  db: NonNullable<ReturnType<typeof getDb>>,
  serverId: string,
  organizationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  return Boolean(row)
}

export function registerServerCommandRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/servers/:id/commands/*', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/hostname', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/timezone', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/ntp', createSessionMiddleware(opts.secrets))

  router.post('/servers/:id/commands/ping', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    if (!(await verifyServerInOrg(db, id, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const record = await createCommandRecord(db, {
      serverId: id,
      actorType: 'user',
      actorId: session.userId,
      type: 'daemon.ping',
      payload: {},
      expiresAt,
    })

    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: id,
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    const enqueueError = await enqueueCommandOrCompensate(
      db,
      commandQueue,
      record,
      envelope,
      c,
    )
    if (enqueueError) return enqueueError

    return c.json({ ok: true, commandId: record.id, status: 'queued' })
  })

  router.post('/servers/:id/commands/reboot', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    if (!(await verifyServerInOrg(db, id, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const expiresAt = new Date(Date.now() + 120_000).toISOString()
    const record = await createCommandRecord(db, {
      serverId: id,
      actorType: 'user',
      actorId: session.userId,
      type: 'server.reboot',
      payload: {},
      expiresAt,
    })

    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: id,
      type: 'server.reboot',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    const enqueueError = await enqueueCommandOrCompensate(
      db,
      commandQueue,
      record,
      envelope,
      c,
    )
    if (enqueueError) return enqueueError

    return c.json({ ok: true, commandId: record.id, status: 'queued' })
  })

  router.post('/servers/:id/hostname', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

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

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    if (!(await verifyServerInOrg(db, id, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    const record = await createCommandRecord(db, {
      serverId: id,
      actorType: 'user',
      actorId: session.userId,
      type: 'server.hostname.set',
      payload: { hostname },
      expiresAt,
    })

    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: id,
      type: 'server.hostname.set',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    const enqueueError = await enqueueCommandOrCompensate(
      db,
      commandQueue,
      record,
      envelope,
      c,
    )
    if (enqueueError) return enqueueError

    return c.json({ ok: true, commandId: record.id, status: 'queued' })
  })

  router.post('/servers/:id/timezone', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

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

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    if (!(await verifyServerInOrg(db, id, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    const record = await createCommandRecord(db, {
      serverId: id,
      actorType: 'user',
      actorId: session.userId,
      type: 'server.timezone.set',
      payload,
      expiresAt,
    })

    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: id,
      type: 'server.timezone.set',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    const enqueueError = await enqueueCommandOrCompensate(
      db,
      commandQueue,
      record,
      envelope,
      c,
    )
    if (enqueueError) return enqueueError

    return c.json({ ok: true, commandId: record.id, status: 'queued' })
  })

  router.post('/servers/:id/ntp', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanManageOr403(c, 'server', id)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const body = await parseJsonBody(c)
    if (body instanceof Response) return body

    let payload
    try {
      payload = parseNtpSetPayload(body)
    } catch {
      return c.json({ error: 'Invalid ntp payload' }, 400)
    }

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    if (!(await verifyServerInOrg(db, id, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const commandQueue = assertDispatchInfrastructure(c)
    if (commandQueue instanceof Response) return commandQueue

    const expiresAt = new Date(Date.now() + 300_000).toISOString()
    const record = await createCommandRecord(db, {
      serverId: id,
      actorType: 'user',
      actorId: session.userId,
      type: 'server.ntp.set',
      payload,
      expiresAt,
    })

    const envelope: CommandEnvelope = {
      commandId: record.id,
      serverId: id,
      type: 'server.ntp.set',
      attempt: 1,
      queuedAt: record.queuedAt ?? record.createdAt,
    }
    const enqueueError = await enqueueCommandOrCompensate(
      db,
      commandQueue,
      record,
      envelope,
      c,
    )
    if (enqueueError) return enqueueError

    return c.json({ ok: true, commandId: record.id, status: 'queued' })
  })

  router.get('/servers/:id/commands/:commandId', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const commandId = c.req.param('commandId')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    const record = await getCommandRecord(db, commandId)
    if (!record) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (record.serverId !== id) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (!(await verifyServerInOrg(db, id, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    if (record.type === 'daemon.ping') {
      return c.json({ ...record, latency: computePingLatency(record) })
    }

    return c.json(record)
  })

  router.get('/servers/:id/commands', async (c) => {
    const db = getDb(c)
    if (!db) return c.json({ error: 'Database unavailable' }, 503)

    const id = c.req.param('id')
    const denied = await assertCanReadOr403(c, 'server', id)
    if (denied) return denied

    const session = c.get('session')
    if (!session) return c.json({ error: 'Unauthorized' }, 401)

    const orgResult = await getOrgId(c, session.userId)
    if (orgResult instanceof Response) return orgResult
    const organizationId = orgResult

    if (!(await verifyServerInOrg(db, id, organizationId))) {
      return c.json({ error: 'Not found' }, 404)
    }

    const commands = await listServerCommands(db, {
      serverId: id,
      limit: 20,
    })

    return c.json({ ok: true, commands })
  })
}
