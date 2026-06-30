import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import type { AuthRouteOpts } from '../authn/http.ts'
import { createSessionMiddleware } from '../authn/middleware.ts'
import {
  assertCanManageOr403,
  assertCanReadOr403,
  getOrgId,
  parseJsonBody,
} from '../shared.ts'
import { getDb, getDaemonCellRegistry } from '../../db.ts'
import { assertValidHostname } from '../../lib/commands/hostname.ts'
import { parsePingResult } from '../../lib/commands/schemas.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import { isNoopCommandQueue } from '../../lib/commands/noop-command-queue.ts'
import { getCommandQueue } from '../../lib/commands/queue.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  createCommandRecord,
  getCommandRecord,
  listServerCommands,
  transitionCommand,
  type CommandRecord,
} from '../../lib/db/command-records.ts'
import { server } from '../../lib/db/schema.ts'

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
  return ms < 0 ? 0 : ms
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

function assertDispatchInfrastructure(c: Context): CommandQueue | Response {
  const registry = getDaemonCellRegistry(c)
  if (!registry) {
    return c.json({ error: 'Daemon cell registry unavailable' }, 503)
  }

  const commandQueue = getCommandQueue(c)
  if (!commandQueue || isNoopCommandQueue(commandQueue)) {
    return c.json({ error: 'Command queue unavailable' }, 503)
  }

  return commandQueue
}

async function enqueueCommandOrCompensate(
  db: NonNullable<ReturnType<typeof getDb>>,
  commandQueue: CommandQueue,
  record: CommandRecord,
  envelope: CommandEnvelope,
  c: Context,
): Promise<Response | null> {
  try {
    await commandQueue.enqueue(envelope)
    return null
  } catch {
    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Command queue unavailable',
    })
    return c.json({ error: 'Command queue unavailable' }, 503)
  }
}

export function registerServerCommandRoutes(router: Hono, opts: AuthRouteOpts) {
  router.use('/servers/:id/commands/*', createSessionMiddleware(opts.secrets))
  router.use('/servers/:id/hostname', createSessionMiddleware(opts.secrets))

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
      actorEntityType: 'user',
      actorEntityId: session.userId,
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
      actorEntityType: 'user',
      actorEntityId: session.userId,
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
      actorEntityType: 'user',
      actorEntityId: session.userId,
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
