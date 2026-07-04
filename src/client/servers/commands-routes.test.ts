/**
 * Route authz for server commands.
 *
 * assertCanReadOr403 and assertCanManageOr403 both resolve to an org-level
 * grant check for server entities (organization:own or organization:manage
 * satisfies either path). The discriminating assertion is grant-present vs
 * grant-absent, not own vs manage.
 */
import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
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
import { deriveSecretsConfig, parseSecretsEnv } from '../authn/secrets.ts'
import {
  command,
  grant,
  member,
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
  transitionCommand,
} from '../../lib/db/command-records.ts'

import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

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
    enqueue: async (envelope) => {
      envelopes.push(envelope)
    },
  }
}

function createMockCell(serverId: string): DaemonCell {
  const noopAsync = async () => {}
  return {
    attachDaemonSocket: async () => ({
      connectionId: 'conn',
      lease: {
        holder: 'conn',
        token: 'conn',
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: noopAsync,
    recordInbound: noopAsync,
    getSnapshot: async () => ({
      serverId,
      version: 0,
      updatedAt: new Date().toISOString(),
      connected: false,
    }),
    putSnapshot: async (patch) => ({
      serverId,
      version: 1,
      updatedAt: new Date().toISOString(),
      connected: false,
      ...patch,
    }),
    enqueue: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'queued' as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: noopAsync,
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'done' as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: noopAsync,
    readOutboxBatch: async () => [],
    ackOutbox: noopAsync,
    prune: async () => false,
    clearUpdateStatus: async () => ({ cleared: 0 }),
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
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async (serverId: string) => {
      purgedIds.push(serverId)
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
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
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
  registerServerRoutes(app, { secrets, runtime: 'deno' })
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
    .values({ displayName: 'Server Commands Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const [insertedUser] = await db
    .insert(user)
    .values({ email, isEmailVerified: true, role: 'user' })
    .returning({ id: user.id })
  const userId = insertedUser!.id

  await db.insert(member).values({ organizationId, userId })

  if (options.withGrant !== false) {
    await db.insert(grant).values({
      entityType: 'organization',
      entityId: organizationId,
      actorType: 'user',
      actorId: userId,
      permission: 'organization:manage',
      allow: true,
    })
  }

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      displayName: 'Commands Test Server',
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
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

Deno.test('POST /servers/:id/commands/ping queues command for authorized user', async () => {
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
    const body = await res.json()
    assertEquals(body.ok, true)
    assertEquals(body.status, 'queued')
    assertEquals(typeof body.commandId, 'string')

    const rows = await db
      .select()
      .from(command)
      .where(eq(command.id, body.commandId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.type, 'daemon.ping')
    assertEquals(rows[0]?.status, 'queued')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertTrimmedCommandEnvelope(commandQueue!.envelopes[0]!, {
      commandId: body.commandId,
      serverId,
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: rows[0]!.queuedAt ?? rows[0]!.createdAt,
    })
  })
})

Deno.test('POST /servers/:id/commands/ping returns 403 without org grant', async () => {
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

Deno.test('POST /servers/:id/commands/reboot queues command for authorized user', async () => {
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
    const body = await res.json()
    assertEquals(body.ok, true)
    assertEquals(body.status, 'queued')
    assertEquals(typeof body.commandId, 'string')

    const rows = await db
      .select()
      .from(command)
      .where(eq(command.id, body.commandId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.type, 'server.reboot')
    assertEquals(rows[0]?.status, 'queued')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertTrimmedCommandEnvelope(commandQueue!.envelopes[0]!, {
      commandId: body.commandId,
      serverId,
      type: 'server.reboot',
      attempt: 1,
      queuedAt: rows[0]!.queuedAt ?? rows[0]!.createdAt,
    })
  })
})

Deno.test('POST /servers/:id/commands/reboot returns 403 without org grant', async () => {
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

Deno.test('POST /servers/:id/commands/reboot returns 403 for cross-org server', async () => {
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
      .values({ displayName: 'Other Org Reboot' })
      .returning({ id: organization.id })

    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: otherOrg!.id,
        displayName: 'Other Server Reboot',
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

Deno.test('POST /servers/:id/hostname validates hostname and queues on success', async () => {
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
    const unsafeBody = await unsafeRes.json()
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
    assertEquals(rows[0]?.type, 'server.hostname.set')
    assertEquals(commandQueue!.envelopes.length, 1)
    assertTrimmedCommandEnvelope(commandQueue!.envelopes[0]!, {
      commandId: rows[0]!.id,
      serverId,
      type: 'server.hostname.set',
      attempt: 1,
      queuedAt: rows[0]!.queuedAt ?? rows[0]!.createdAt,
    })
  })
})

Deno.test('POST /servers/:id/hostname returns 403 without org grant', async () => {
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

Deno.test('POST /servers/:id/commands/ping and hostname return 403 for cross-org server', async () => {
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
      .values({ displayName: 'Other Org' })
      .returning({ id: organization.id })

    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: otherOrg!.id,
        displayName: 'Other Server',
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

Deno.test('GET /servers/:id/commands/:commandId returns latency for terminal ping', async () => {
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
      actorEntityType: 'user',
      actorEntityId: userId,
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
    const body = await res.json()
    assertEquals(body.id, record.id)
    assertEquals(body.latency.apiToConsumerMs, 10)
    assertEquals(body.latency.consumerToCellMs, 20)
    assertEquals(body.latency.cellToDaemonMs, 5)
    assertEquals(body.latency.daemonProcessingMs, 10)
    assertEquals(body.latency.daemonToRecordedMs, 25)
    assertEquals(body.latency.totalRoundTripMs, 60)
  })
})

Deno.test('GET /servers/:id/commands/:commandId returns 404 for cross-org or unknown ids', async () => {
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
      .values({ displayName: 'Other Org' })
      .returning({ id: organization.id })

    const now = new Date().toISOString()
    const [otherServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: otherOrg!.id,
        displayName: 'Other Server',
      })
      .returning({ id: server.id })

    const crossOrgCommand = await createCommandRecord(db, {
      serverId: otherServer!.id,
      actorEntityType: 'user',
      actorEntityId: userId,
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

Deno.test('command routes return 503 when dispatch infrastructure is unavailable', async () => {
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
