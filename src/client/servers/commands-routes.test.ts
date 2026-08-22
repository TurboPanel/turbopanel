/**
 * Route authz for server commands.
 *
 * assertCanReadOr403 and assertCanManageOr403 both resolve to an org-level
 * grant check for server entities (organization:own or organization:manage
 * satisfies either path). The discriminating assertion is grant-present vs
 * grant-absent, not own vs manage.
 */
import { assertEquals } from '@std/assert'
import { and, eq } from 'drizzle-orm'
import { it } from '@std/testing/bdd'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import {
  command,
  grant,
  organization,
  server,
  user,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerServerRoutes } from './routes.ts'
import type { CommandEnvelope } from '../../lib/commands/envelope.ts'
import type { CommandQueue } from '../../lib/commands/queue.ts'
import {
  createCommandRecord,
  getCommandRecord,
  transitionCommand,
} from '../../lib/db/command-records.ts'
import { COMMAND_STATUS_BATCH_LIMIT } from './commands-routes-helpers.ts'

import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

function assertTrimmedCommandEnvelope(
  envelope: CommandEnvelope,
  expected: {
    commandId: string
    serverId: string
    type: CommandEnvelope['type']
    attempt: number
    queuedAt: string
    correlationId?: string
  },
): void {
  assertEquals(envelope.commandId, expected.commandId)
  assertEquals(envelope.serverId, expected.serverId)
  assertEquals(envelope.type, expected.type)
  assertEquals(envelope.attempt, expected.attempt)
  assertEquals(envelope.queuedAt, expected.queuedAt)
  assertEquals(envelope.correlationId, expected.correlationId)
  assertEquals('organizationId' in envelope, false)
}

function createRecordingCommandQueue(): CommandQueue & { envelopes: CommandEnvelope[] } {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

function createMockCell(serverId: string): DaemonCell {
  const noopAsync = () => Promise.resolve()
  return {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          token: 'conn',
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: () =>
      Promise.resolve({
        serverId,
        version: 0,
        updatedAt: new Date().toISOString(),
        connected: false,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId,
        version: 1,
        updatedAt: new Date().toISOString(),
        connected: false,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: noopAsync,
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(null),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: noopAsync,
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: noopAsync,
  }
}

function createTrackingRegistry(): DaemonCellRegistry & { purgedIds: string[] } {
  const purgedIds: string[] = []
  const cells = new Map<string, DaemonCell>()
  return {
    purgedIds,
    getCell(serverId: string): DaemonCell {
      let cell = cells.get(serverId)
      if (!cell) {
        cell = createMockCell(serverId)
        cells.set(serverId, cell)
      }
      return cell
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: (serverId: string) => {
      purgedIds.push(serverId)
      return Promise.resolve()
    },
  }
}

async function createCommandsRoutesTestApp(
  db: ReturnType<typeof createDenoDb>,
  options?: {
    registry?: DaemonCellRegistry
    commandQueue?: CommandQueue
  },
) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (options?.registry) {
      c.set('daemonCellRegistry', options.registry)
    }
    if (options?.commandQueue) {
      c.set('commandQueue', options.commandQueue)
    }
    return next()
  })
  registerServerRoutes(app, { secrets, runtime: 'deno', signupEnvOverride: undefined })
  return { app, secrets }
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function withCommandRouteFixtures(
  options: {
    withGrant?: boolean
    withCommandQueue?: boolean
    withRegistry?: boolean
  },
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    userId: string
    organizationId: string
    serverId: string
    commandQueue: ReturnType<typeof createRecordingCommandQueue> | undefined
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping server command route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const commandQueue = options.withCommandQueue === false
    ? undefined
    : createRecordingCommandQueue()
  const registry = options.withRegistry === false ? undefined : createTrackingRegistry()
  const { app, secrets } = await createCommandsRoutesTestApp(db, {
    registry,
    commandQueue,
  })

  const email = `server-commands-test-${crypto.randomUUID()}@example.com`
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Server Commands Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id


  if (options.withGrant !== false) {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
    })
  }

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Commands Test Server',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({
      db,
      app,
      secrets,
      userId,
      organizationId,
      serverId,
      commandQueue,
    })
  } finally {
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

it('POST /servers/:id/commands/ping queues command for authorized user', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/commands/ping`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      status: string
      commandId: string
    }
    assertEquals(body.ok, true)
    assertEquals(body.status, 'queued')
    assertEquals(typeof body.commandId, 'string')

    const record = await getCommandRecord(db, body.commandId)
    assertEquals(record?.type, 'daemon.ping')
    assertEquals(record?.status, 'queued')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertTrimmedCommandEnvelope(commandQueue!.envelopes[0]!, {
      commandId: body.commandId,
      serverId,
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: record!.queuedAt ?? record!.createdAt,
    })
  })
})

it('POST /servers/:id/commands/ping returns 403 without org grant', async () => {
  await withCommandRouteFixtures({ withGrant: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/commands/ping`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 403)
    assertEquals(commandQueue!.envelopes.length, 0)
  })
})

it('POST /servers/:id/commands/reboot queues command for authorized user', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/commands/reboot`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      status: string
      commandId: string
    }
    assertEquals(body.ok, true)
    assertEquals(body.status, 'queued')
    assertEquals(typeof body.commandId, 'string')

    const record = await getCommandRecord(db, body.commandId)
    assertEquals(record?.type, 'server.reboot')
    assertEquals(record?.status, 'queued')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertTrimmedCommandEnvelope(commandQueue!.envelopes[0]!, {
      commandId: body.commandId,
      serverId,
      type: 'server.reboot',
      attempt: 1,
      queuedAt: record!.queuedAt ?? record!.createdAt,
    })
  })
})

it('POST /servers/:id/commands/reboot returns 403 without org grant', async () => {
  await withCommandRouteFixtures({ withGrant: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/commands/reboot`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 403)
    assertEquals(commandQueue!.envelopes.length, 0)
  })
})

it('POST /servers/:id/commands/reboot returns 403 for cross-org server', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    commandQueue,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Other Org Reboot' })
      .returning({ id: organization.id })

    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: otherOrg!.id,
        name: 'Other Server Reboot',
      })
      .returning({ id: server.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${otherServer!.id}/commands/reboot`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 403)
    assertEquals(commandQueue!.envelopes.length, 0)

    const rows = await db
      .select()
      .from(command)
      .where(eq(command.serverId, otherServer!.id))
    assertEquals(rows.length, 0)

    await db.delete(server).where(eq(server.id, otherServer!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

it('POST /servers/:id/hostname validates hostname and queues on success', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const okRes = await app.request(`/servers/${serverId}/hostname`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: 'web-01' }),
    })
    assertEquals(okRes.status, 200)

    const unsafeRes = await app.request(`/servers/${serverId}/hostname`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: 'a;rm -rf /' }),
    })
    assertEquals(unsafeRes.status, 400)
    const unsafeBody = await unsafeRes.json() as { error: string }
    assertEquals(unsafeBody.error, 'Invalid hostname')

    const emptyRes = await app.request(`/servers/${serverId}/hostname`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: '' }),
    })
    assertEquals(emptyRes.status, 400)

    const rows = await db.select().from(command).where(eq(command.serverId, serverId))
    assertEquals(rows.length, 1)
    const record = await getCommandRecord(db, rows[0]!.id)
    assertEquals(record?.type, 'server.hostname.set')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertTrimmedCommandEnvelope(commandQueue!.envelopes[0]!, {
      commandId: rows[0]!.id,
      serverId,
      type: 'server.hostname.set',
      attempt: 1,
      queuedAt: record!.queuedAt ?? record!.createdAt,
    })
  })
})

it('POST /servers/:id/timezone queues command without persisting options.timezone', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const okRes = await app.request(`/servers/${serverId}/timezone`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timezone: 'America/Chicago' }),
    })
    assertEquals(okRes.status, 200)
    const okBody = await okRes.json() as { ok: boolean; commandId: string; status: string }
    assertEquals(okBody.ok, true)
    assertEquals(okBody.status, 'queued')

    const [row] = await db
      .select({ options: server.options })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const options = row?.options as { timezone?: string } | null
    assertEquals(options?.timezone, undefined)

    const commands = await db.select().from(command).where(eq(command.serverId, serverId))
    assertEquals(commands.length, 1)
    const record = await getCommandRecord(db, commands[0]!.id)
    assertEquals(record?.type, 'server.timezone.set')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertTrimmedCommandEnvelope(commandQueue!.envelopes[0]!, {
      commandId: commands[0]!.id,
      serverId,
      type: 'server.timezone.set',
      attempt: 1,
      queuedAt: record!.queuedAt ?? record!.createdAt,
    })
  })
})

it('POST /servers/:id/ntp is manage-gated and validates payload', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const okRes = await app.request(`/servers/${serverId}/ntp`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        enabled: true,
        servers: ['time.cloudflare.com'],
      }),
    })
    assertEquals(okRes.status, 200)

    const badRes = await app.request(`/servers/${serverId}/ntp`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ servers: ['999.999.999.999'] }),
    })
    assertEquals(badRes.status, 400)

    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Other Org NTP' })
      .returning({ id: organization.id })
    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        organizationId: otherOrg!.id,
        name: 'Other',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: server.id })

    const crossRes = await app.request(`/servers/${otherServer!.id}/ntp`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    })
    // Cross-org server fails authz (403) or verifyServerInOrg (404) depending
    // on grant resolution order; both deny the enqueue.
    assertEquals([403, 404].includes(crossRes.status), true)
    assertEquals(commandQueue!.envelopes.length, 1)

    await db.delete(server).where(eq(server.id, otherServer!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

it('POST /servers/:id/hostname returns 403 without org grant', async () => {
  await withCommandRouteFixtures({ withGrant: false }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
    commandQueue,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/hostname`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: 'web-01' }),
    })

    assertEquals(res.status, 403)
    assertEquals(commandQueue!.envelopes.length, 0)
    const rows = await db.select().from(command).where(eq(command.serverId, serverId))
    assertEquals(rows.length, 0)
  })
})

it('POST /servers/:id/commands/ping and hostname return 403 for cross-org server', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    commandQueue,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Other Org' })
      .returning({ id: organization.id })

    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: otherOrg!.id,
        name: 'Other Server',
      })
      .returning({ id: server.id })

    const cookie = await sessionCookie(db, secrets, userId)

    const pingRes = await app.request(`/servers/${otherServer!.id}/commands/ping`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(pingRes.status, 403)
    assertEquals(commandQueue!.envelopes.length, 0)

    const hostnameRes = await app.request(`/servers/${otherServer!.id}/hostname`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: 'web-01' }),
    })
    assertEquals(hostnameRes.status, 403)
    assertEquals(commandQueue!.envelopes.length, 0)

    const rows = await db
      .select()
      .from(command)
      .where(eq(command.serverId, otherServer!.id))
    assertEquals(rows.length, 0)

    await db.delete(server).where(eq(server.id, otherServer!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

it('GET /servers/:id/commands/:commandId returns latency for terminal ping', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const record = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: userId,
      type: 'daemon.ping',
      payload: {},
    })

    await transitionCommand(db, record.id, {
      status: 'succeeded',
      queuedAt: '2020-01-01T00:00:00.000Z',
      dispatchStartedAt: '2020-01-01T00:00:00.010Z',
      sentAt: '2020-01-01T00:00:00.020Z',
      ackedAt: '2020-01-01T00:00:00.035Z',
      finishedAt: '2020-01-01T00:00:00.060Z',
      result: {
        cellDispatchedAt: '2020-01-01T00:00:00.030Z',
        daemonReceivedAt: '2020-01-01T00:00:00.040Z',
        daemonRespondedAt: '2020-01-01T00:00:00.050Z',
      },
    })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request(`/servers/${serverId}/commands/${record.id}`, {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      id: string
      latency: {
        apiToConsumerMs: number
        consumerToCellMs: number
        cellToDaemonMs: number
        daemonProcessingMs: number
        daemonToRecordedMs: number
        totalRoundTripMs: number
      }
    }
    assertEquals(body.id, record.id)
    assertEquals(body.latency.apiToConsumerMs, 10)
    assertEquals(body.latency.consumerToCellMs, 20)
    assertEquals(body.latency.cellToDaemonMs, 5)
    assertEquals(body.latency.daemonProcessingMs, 10)
    assertEquals(body.latency.daemonToRecordedMs, 25)
    assertEquals(body.latency.totalRoundTripMs, 60)
  })
})

it('GET /servers/:id/commands exposes both error and errorMessage for failures', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const record = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: userId,
      type: 'daemon.ping',
      payload: {},
    })

    await transitionCommand(db, record.id, {
      status: 'failed',
      error: 'Daemon not connected',
      errorCode: 'daemon_offline',
    })

    const cookie = await sessionCookie(db, secrets, userId)
    const headers = { Cookie: cookie, [ORG_ID_HEADER]: organizationId }

    const detailRes = await app.request(
      `/servers/${serverId}/commands/${record.id}`,
      { headers },
    )
    assertEquals(detailRes.status, 200)
    const detail = await detailRes.json() as {
      error: string | null
      errorMessage: string | null
      errorCode: string | null
    }
    assertEquals(detail.error, 'Daemon not connected')
    assertEquals(detail.errorMessage, 'Daemon not connected')
    assertEquals(detail.errorCode, 'daemon_offline')

    const listRes = await app.request(`/servers/${serverId}/commands`, { headers })
    assertEquals(listRes.status, 200)
    const list = await listRes.json() as {
      commands: { id: string; error: string | null; errorMessage: string | null }[]
    }
    const listed = list.commands.find((entry) => entry.id === record.id)
    assertEquals(listed?.error, 'Daemon not connected')
    assertEquals(listed?.errorMessage, 'Daemon not connected')
  })
})

it('GET /servers/:id/commands/:commandId returns 404 for cross-org or unknown ids', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Other Org' })
      .returning({ id: organization.id })

    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: otherOrg!.id,
        name: 'Other Server',
      })
      .returning({ id: server.id })

    const crossOrgCommand = await createCommandRecord(db, {
      serverId: otherServer!.id,
      actorType: 'user',
      actorId: userId,
      type: 'daemon.ping',
      payload: {},
    })

    const cookie = await sessionCookie(db, secrets, userId)

    const crossOrgRes = await app.request(
      `/servers/${serverId}/commands/${crossOrgCommand.id}`,
      {
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )
    assertEquals(crossOrgRes.status, 404)

    const unknownRes = await app.request(
      `/servers/${serverId}/commands/${crypto.randomUUID()}`,
      {
        headers: {
          Cookie: cookie,
          [ORG_ID_HEADER]: organizationId,
        },
      },
    )
    assertEquals(unknownRes.status, 404)

    await db.delete(command).where(eq(command.id, crossOrgCommand.id))
    await db.delete(server).where(eq(server.id, otherServer!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

it('command routes return 503 when dispatch infrastructure is unavailable', async () => {
  await withCommandRouteFixtures({
    withCommandQueue: false,
    withRegistry: true,
  }, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)

    const pingRes = await app.request(`/servers/${serverId}/commands/ping`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(pingRes.status, 503)

    const hostnameRes = await app.request(`/servers/${serverId}/hostname`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostname: 'web-01' }),
    })
    assertEquals(hostnameRes.status, 503)

    const rebootRes = await app.request(`/servers/${serverId}/commands/reboot`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })
    assertEquals(rebootRes.status, 503)

    const rows = await db.select().from(command).where(eq(command.serverId, serverId))
    assertEquals(rows.length, 0)
  })
})

it('POST /commands/status returns lean statuses for many ids in one request', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const queued = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: userId,
      type: 'daemon.ping',
      payload: {},
    })
    const finished = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: userId,
      type: 'server.reboot',
      payload: {},
    })
    await transitionCommand(db, finished.id, {
      status: 'failed',
      error: 'Daemon not connected',
      errorCode: 'daemon_offline',
      finishedAt: '2020-01-01T00:00:00.000Z',
    })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/commands/status', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: [queued.id, finished.id] }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as {
      ok: boolean
      commands: Record<string, unknown>[]
    }
    assertEquals(body.ok, true)
    assertEquals(body.commands.length, 2)

    const byId = new Map(body.commands.map((row) => [row.id as string, row]))
    const queuedRow = byId.get(queued.id)!
    assertEquals(queuedRow.serverId, serverId)
    assertEquals(queuedRow.status, 'queued')
    assertEquals(queuedRow.type, 'daemon.ping')
    assertEquals(queuedRow.hasLog, false)

    const failedRow = byId.get(finished.id)!
    assertEquals(failedRow.status, 'failed')
    assertEquals(failedRow.errorMessage, 'Daemon not connected')
    assertEquals(failedRow.errorCode, 'daemon_offline')

    // The batched projection stays lean — dispatch internals never ship.
    for (const row of body.commands) {
      assertEquals('payload' in row, false)
      assertEquals('result' in row, false)
      assertEquals('context' in row, false)
      assertEquals('dispatch' in row, false)
    }
  })
})

it('POST /commands/status omits invisible and cross-org ids instead of 403ing the batch', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    serverId,
  }) => {
    const visible = await createCommandRecord(db, {
      serverId,
      actorType: 'user',
      actorId: userId,
      type: 'daemon.ping',
      payload: {},
    })

    const [otherOrg] = await db
      .insert(organization)
      .values({ name: 'Other Org Status' })
      .returning({ id: organization.id })

    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: otherOrg!.id,
        name: 'Other Server Status',
      })
      .returning({ id: server.id })

    const crossOrgCommand = await createCommandRecord(db, {
      serverId: otherServer!.id,
      actorType: 'user',
      actorId: userId,
      type: 'daemon.ping',
      payload: {},
    })

    const cookie = await sessionCookie(db, secrets, userId)
    const res = await app.request('/commands/status', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: [visible.id, crossOrgCommand.id, crypto.randomUUID()],
      }),
    })

    assertEquals(res.status, 200)
    const body = await res.json() as { ok: boolean; commands: { id: string }[] }
    assertEquals(body.ok, true)
    assertEquals(body.commands.map((row) => row.id), [visible.id])

    await db.delete(command).where(eq(command.id, crossOrgCommand.id))
    await db.delete(server).where(eq(server.id, otherServer!.id))
    await db.delete(organization).where(eq(organization.id, otherOrg!.id))
  })
})

it('POST /commands/status rejects oversize and malformed bodies with 400', async () => {
  await withCommandRouteFixtures({}, async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const headers = {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    }

    const post = (body: unknown) =>
      app.request('/commands/status', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

    const oversize = await post({
      ids: Array.from(
        { length: COMMAND_STATUS_BATCH_LIMIT + 1 },
        () => crypto.randomUUID(),
      ),
    })
    assertEquals(oversize.status, 400)
    assertEquals(
      (await oversize.json() as { error: string }).error,
      'Too many command ids',
    )

    const empty = await post({ ids: [] })
    assertEquals(empty.status, 400)

    const notAnArray = await post({ ids: 'cmd-1' })
    assertEquals(notAnArray.status, 400)

    const nonStringId = await post({ ids: [crypto.randomUUID(), 42] })
    assertEquals(nonStringId.status, 400)

    const missingIds = await post({})
    assertEquals(missingIds.status, 400)
  })
})
