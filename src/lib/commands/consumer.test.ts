import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../../daemon/cell/contracts.ts'
import { buildServerDaemonState } from '../../daemon/authn/daemon-state.ts'
import { attachDaemonStateToServer } from '../../daemon/authn/server-identity-db.ts'
import {
  command,
  organization,
  server,
} from '../db/schema.ts'
import {
  createCommandRecord,
  getCommandRecord,
  transitionCommand,
} from '../db/command-records.ts'
import { processCommandEnvelope } from './consumer.ts'
import type { CommandEnvelope } from './envelope.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const TEST_COMMAND_ACTOR = {
  actorEntityType: 'user',
  actorEntityId: '00000000-0000-4000-8000-000000000001',
} as const

async function attachConnectedDaemonStatus(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<void> {
  await attachDaemonStateToServer(db, serverId, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp-test',
  })
  const daemonState = buildServerDaemonState({
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp-test',
  })
  const now = new Date().toISOString()
  daemonState.status = {
    connected: true,
    daemonStatus: 'online',
    lastSeenAt: now,
    connectedAt: now,
    disconnectedAt: null,
    statusChangedAt: now,
  }
  await db.update(server).set({
    daemon: daemonState,
    updatedAt: now,
  }).where(eq(server.id, serverId))
}

function createDispatchMockRegistry(
  serverId: string,
  options: {
    waitForRequestResult: PendingRequestRecord | null
  },
): DaemonCellRegistry & {
  enqueueCalled: boolean
  waitForRequestCalled: boolean
  capturedOutbound: unknown
} {
  const state = {
    enqueueCalled: false,
    waitForRequestCalled: false,
    capturedOutbound: null as unknown,
  }

  const cell: DaemonCell = {
    attachDaemonSocket: async () => ({
      connectionId: 'conn',
      lease: {
        holder: 'conn',
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    }),
    detachDaemonSocket: async () => {},
    recordInbound: async () => {},
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
    enqueue: async (outbound) => {
      state.enqueueCalled = true
      state.capturedOutbound = outbound
      return {
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }
    },
    markSent: async () => {},
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => {
      state.waitForRequestCalled = true
      return options.waitForRequestResult
    },
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
    releaseDeliveryLease: async () => {},
    readOutboxBatch: async () => [],
    ackOutbox: async () => {},
    prune: async () => [],
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: async () => {},
  }

  return {
    get enqueueCalled() {
      return state.enqueueCalled
    },
    get waitForRequestCalled() {
      return state.waitForRequestCalled
    },
    get capturedOutbound() {
      return state.capturedOutbound
    },
    getCell: () => cell,
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
  }
}

async function withConsumerFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping command consumer tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ displayName: 'Command Consumer Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      displayName: 'Consumer Test Server',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, organizationId, serverId })
  } finally {
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

function buildEnvelope(
  record: Awaited<ReturnType<typeof createCommandRecord>>,
  serverId: string,
): CommandEnvelope {
  return {
    commandId: record.id,
    serverId,
    type: record.type as CommandEnvelope['type'],
    attempt: 1,
    queuedAt: record.queuedAt ?? record.createdAt,
  }
}

test('processCommandEnvelope fails fast when daemon is offline', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const registry = createDispatchMockRegistry(serverId, { waitForRequestResult: null })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
    assertEquals(updated?.error, 'Daemon not connected')
    assertEquals(updated?.attempts, 1)
    assertEquals(registry.enqueueCalled, false)
    assertEquals(registry.waitForRequestCalled, false)
  })
})

test('processCommandEnvelope succeeds for online ping command', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })

    const daemonReceivedAt = '2020-01-01T00:00:00.100Z'
    const daemonRespondedAt = '2020-01-01T00:00:00.200Z'
    const ackAt = '2020-01-01T00:00:00.150Z'
    const finishedAt = '2020-01-01T00:00:00.250Z'

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'done',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        ackAt,
        finishedAt,
        result: {
          daemonReceivedAt,
          daemonRespondedAt,
          daemonHostname: 'web-01',
        },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const outbound = registry.capturedOutbound as Record<string, unknown>
    assertEquals(outbound.kind, 'command-dispatch')
    assertEquals(outbound.requestId, record.id)
    assertEquals(outbound.commandType, 'daemon.ping')
    assertEquals(registry.enqueueCalled, true)
    assertEquals(registry.waitForRequestCalled, true)

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')
    assertEquals(updated?.ackedAt, ackAt)
    assertEquals(updated?.finishedAt, finishedAt)
    assertEquals((updated?.result as Record<string, unknown>).daemonHostname, 'web-01')
  })
})

test('processCommandEnvelope updates server metadata on hostname success', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.hostname.set',
      payload: { hostname: 'web-09' },
    })

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'done',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        finishedAt: new Date().toISOString(),
        result: { observedHostname: 'web-09' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')

    const [row] = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals((row?.metadata as Record<string, unknown>).hostname, 'web-09')
  })
})

test('processCommandEnvelope maps failed and timed out pending requests', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const failedRecord = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const failedRegistry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: failedRecord.id,
        requestKind: 'command-dispatch',
        status: 'failed',
        createdAt: failedRecord.createdAt,
        expiresAt: failedRecord.createdAt,
        error: 'daemon rejected command',
      },
    })
    await processCommandEnvelope(
      db,
      failedRegistry,
      buildEnvelope(failedRecord, serverId),
    )
    const failedUpdated = await getCommandRecord(db, failedRecord.id)
    assertEquals(failedUpdated?.status, 'failed')
    assertEquals(failedUpdated?.error, 'daemon rejected command')

    const timeoutRecord = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const timeoutRegistry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })
    await processCommandEnvelope(
      db,
      timeoutRegistry,
      buildEnvelope(timeoutRecord, serverId),
    )
    const timeoutUpdated = await getCommandRecord(db, timeoutRecord.id)
    assertEquals(timeoutUpdated?.status, 'timed_out')
  })
})

test('processCommandEnvelope no-ops for terminal or expired commands', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const succeeded = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    await transitionCommand(db, succeeded.id, { status: 'succeeded', result: {} })

    const succeededRegistry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })
    await processCommandEnvelope(
      db,
      succeededRegistry,
      buildEnvelope(succeeded, serverId),
    )
    assertEquals(succeededRegistry.enqueueCalled, false)

    const expired = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const expiredRegistry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })
    await processCommandEnvelope(
      db,
      expiredRegistry,
      buildEnvelope(expired, serverId),
    )
    const expiredUpdated = await getCommandRecord(db, expired.id)
    assertEquals(expiredUpdated?.status, 'timed_out')
    assertEquals(expiredRegistry.enqueueCalled, false)
  })
})
