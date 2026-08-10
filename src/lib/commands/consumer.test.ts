import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb, endDbConnection } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../../daemon/cell/contracts.ts'
import { attachDaemonStateToServer } from '../../daemon/authn/server-identity-db.ts'
import {
  command,
  container,
  environment,
  ip,
  managed,
  node,
  organization,
  peer,
  principal,
  project,
  server,
  service,
  vpn,
  workspace,
} from '../db/schema.ts'
import {
  createCommandRecord,
  getCommandRecord,
  transitionCommand,
} from '../db/command-records.ts'
import { processCommandEnvelope, isTransientError } from './consumer.ts'
import type { CommandEnvelope } from './envelope.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isTransientError classifies retryable infrastructure failures', () => {
  assertEquals(isTransientError(new Error('network timeout')), true)
  assertEquals(isTransientError(new Error('ECONNREFUSED to postgres')), true)
  assertEquals(isTransientError(new Error('cell unavailable')), true)
  assertEquals(isTransientError('redis connection reset'), true)
  assertEquals(isTransientError(new Error('ECONNRESET from peer')), true)
  assertEquals(isTransientError(new Error('request timed out waiting')), true)
  assertEquals(isTransientError(new Error('failed to fetch command status')), true)
  assertEquals(isTransientError(new Error('database is temporarily unreachable')), true)
  const named = new Error('upstream died')
  named.name = 'TimeoutError'
  assertEquals(isTransientError(named), true)
  const networkNamed = new Error('boom')
  networkNamed.name = 'NetworkError'
  assertEquals(isTransientError(networkNamed), true)
})

test('isTransientError rejects permanent validation failures', () => {
  assertEquals(isTransientError(new Error('invalid command envelope')), false)
  assertEquals(isTransientError(new Error('data integrity violation')), false)
  assertEquals(isTransientError(new Error('overloaded queue')), false)
  assertEquals(isTransientError(new Error('permission denied for table')), false)
})

const TEST_COMMAND_ACTOR = {
  actorType: 'user',
  actorId: '00000000-0000-4000-8000-000000000001',
} as const

async function attachConnectedDaemonStatus(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
): Promise<void> {
  await attachDaemonStateToServer(db, serverId, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    fingerprint: 'fp-test',
  })
  const now = new Date().toISOString()
  // Fleet status lives on dedicated `server` columns now — never on
  // `server.daemon` jsonb (see `mapServerDaemonStatusFromColumns`).
  await db.update(server).set({
    connected: true,
    statusChangedAt: now,
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
    .values({ name: 'Command Consumer Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId,
      name: 'Consumer Test Server',
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  try {
    await fn({ db, organizationId, serverId })
  } finally {
    await db.delete(command).where(eq(command.serverId, serverId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
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

test('processCommandEnvelope does not persist timezone option when daemon is offline', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    const now = new Date().toISOString()
    await db.update(server).set({
      options: { timezone: 'UTC' },
      updatedAt: now,
    }).where(eq(server.id, serverId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.timezone.set',
      payload: { timezone: 'America/Chicago' },
    })
    const registry = createDispatchMockRegistry(serverId, { waitForRequestResult: null })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ options: server.options })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals((row?.options as { timezone?: string }).timezone, 'UTC')
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

    // Hostname is a dedicated `server` column now (see `touchServerMetadata` /
    // `identityColumnPatch` in server-registry.ts) — never `server.metadata`.
    const [row] = await db
      .select({ hostname: server.hostname })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals(row?.hostname, 'web-09')
  })
})

test('processCommandEnvelope persists server.options.timezone only after successful timezone command', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.timezone.set',
      payload: { timezone: 'America/Chicago' },
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
        result: { timezone: 'America/Chicago' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ options: server.options, metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const options = row?.options as { timezone?: string } | null
    assertEquals(options?.timezone, 'America/Chicago')
    const timeSync = (row?.metadata as Record<string, unknown>).timeSync as
      | Record<string, unknown>
      | undefined
    assertEquals(timeSync?.timezone, 'America/Chicago')
    assertEquals(typeof timeSync?.capturedAt, 'string')
  })
})

test('processCommandEnvelope leaves server.options.timezone unchanged on timezone failure', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const now = new Date().toISOString()
    await db.update(server).set({
      options: { timezone: 'UTC' },
      updatedAt: now,
    }).where(eq(server.id, serverId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.timezone.set',
      payload: { timezone: 'America/Chicago' },
    })

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'failed',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        error: 'daemon rejected command',
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ options: server.options })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals((row?.options as { timezone?: string }).timezone, 'UTC')
  })
})

test('processCommandEnvelope leaves server.options.timezone unchanged on timezone timeout', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const now = new Date().toISOString()
    await db.update(server).set({
      options: { timezone: 'UTC' },
      updatedAt: now,
    }).where(eq(server.id, serverId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.timezone.set',
      payload: { timezone: 'America/Chicago' },
    })

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ options: server.options })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals((row?.options as { timezone?: string }).timezone, 'UTC')
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

test('processCommandEnvelope leaves metadata.timeSync unchanged on malformed ntp success', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const priorTimeSync = {
      timezone: 'UTC',
      ntpEnabled: true,
      ntpServers: ['pool.ntp.org'],
      capturedAt: new Date().toISOString(),
    }
    const now = new Date().toISOString()
    await db.update(server).set({
      metadata: { timeSync: priorTimeSync },
      updatedAt: now,
    }).where(eq(server.id, serverId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.ntp.set',
      payload: { enabled: true, servers: ['time.cloudflare.com'] },
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
        result: { ntpEnabled: true, ntpSynced: true },
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
    assertEquals(
      (row?.metadata as Record<string, unknown>).timeSync,
      priorTimeSync,
    )
  })
})

test('processCommandEnvelope wireguard reconcile preserves tunnel_ip_id', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [vpnRow] = await db.insert(vpn).values({
      organizationId,
      cidr: '203.0.113.0/24',
      name: 'Consumer Mesh',
    }).returning({ id: vpn.id })
    const [tunnel] = await db.insert(ip).values({
      organizationId,
      vpnId: vpnRow!.id,
      serverId,
      address: '203.0.113.10',
      allocation: 'dedicated',
      scope: 'vpn',
    }).returning({ id: ip.id })
    const priorPublicKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    const [peerRow] = await db.insert(peer).values({
      vpnId: vpnRow!.id,
      serverId,
      publicKey: priorPublicKey,
      tunnelIpId: tunnel!.id,
      role: 'member',
    }).returning({ id: peer.id, tunnelIpId: peer.tunnelIpId })

    const newPublicKey = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB='
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.wireguard.apply',
      payload: {
        vpnId: vpnRow!.id,
        peerId: peerRow!.id,
        interfaceName: 'tpwg550e8400',
        address: '203.0.113.10/24',
        peers: [],
      },
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
        result: {
          interfaceName: 'tpwg550e8400',
          publicKey: newPublicKey,
          applied: true,
          listenPort: 51820,
        },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')

    const [reconciled] = await db
      .select({
        publicKey: peer.publicKey,
        tunnelIpId: peer.tunnelIpId,
        listenPort: peer.listenPort,
      })
      .from(peer)
      .where(eq(peer.id, peerRow!.id))
      .limit(1)
    assertEquals(reconciled?.publicKey, newPublicKey)
    assertEquals(reconciled?.tunnelIpId, peerRow!.tunnelIpId)
    assertEquals(reconciled?.listenPort, 51820)

    await db.delete(peer).where(eq(peer.id, peerRow!.id))
    await db.delete(ip).where(eq(ip.id, tunnel!.id))
    await db.delete(vpn).where(eq(vpn.id, vpnRow!.id))
  })
})

/**
 * Full workspace → project → environment → managed → principal chain, plus a
 * connected daemon on `serverId` — the minimal fixture that satisfies the FK
 * requirements to exercise `applyManagedDestroySideEffect`.
 */
async function withManagedDestroyFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
    managedId: string
    rootPrincipalId: string
  }) => Promise<void>,
): Promise<void> {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Managed Destroy Test Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'Managed Destroy Test Project',
        metadata: { type: 'managed' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Production',
      })
      .returning({ id: environment.id })
    const [managedRow] = await db
      .insert(managed)
      .values({
        environmentId: environmentRow!.id,
        serverId,
        name: 'Managed Destroy Test Postgres',
        engine: 'postgres',
        status: 'ready',
        metadata: {},
        options: { settings: {}, databases: ['postgres'] },
      })
      .returning({ id: managed.id })
    const managedId = managedRow!.id
    const [principalRow] = await db
      .insert(principal)
      .values({
        kind: 'database',
        provider: 'postgres',
        username: 'postgres',
        managedId,
        metadata: { managedRoot: true },
      })
      .returning({ id: principal.id })

    try {
      await fn({
        db,
        serverId,
        managedId,
        rootPrincipalId: principalRow!.id,
      })
    } finally {
      await db.delete(principal).where(eq(principal.managedId, managedId))
      await db.delete(managed).where(eq(managed.id, managedId))
      await db.delete(environment).where(eq(environment.id, environmentRow!.id))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
}

test('processCommandEnvelope deletes the managed row and cascades principals when deleteAfterDestroy succeeds', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId, rootPrincipalId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.destroy',
      payload: { managedId, removeVolumes: true, deleteAfterDestroy: true },
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
        result: { status: 'stopped', containers: [] },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')

    // Single-click delete: a successful destroy with the deleteAfterDestroy
    // marker removes the managed row, which cascades to its principals via
    // `principal.managed_id ON DELETE CASCADE`.
    const [managedAfter] = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedAfter, undefined)

    const [principalAfter] = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.id, rootPrincipalId))
      .limit(1)
    assertEquals(principalAfter, undefined)
  })
})

test('processCommandEnvelope leaves the managed row and principals in place without deleteAfterDestroy', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId, rootPrincipalId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.destroy',
      payload: { managedId, removeVolumes: true },
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
        result: { status: 'stopped', containers: [] },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')

    // No marker → this is not (yet) an API hard-delete completion, so the row
    // and its principal must survive a successful destroy — this is the seam
    // reserved for a future "destroy runtime only" action.
    const [managedAfter] = await db
      .select({ id: managed.id, status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedAfter?.id, managedId)
    assertEquals(managedAfter?.status, 'stopped')

    const [principalAfter] = await db
      .select({ id: principal.id })
      .from(principal)
      .where(eq(principal.id, rootPrincipalId))
      .limit(1)
    assertEquals(principalAfter?.id, rootPrincipalId)
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

test('processCommandEnvelope reconciles containers on environment.lifecycle success', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Lifecycle Reconcile Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'Lifecycle Reconcile Project',
        metadata: { type: 'docker-compose' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Production',
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'web',
      composeServiceName: 'web',
      })
      .returning({ id: service.id })
    await db.insert(container).values({
      serviceId: serviceRow!.id,
      serverId,
      containerId: 'old-cid',
      containerName: 'proj-web-1',
      status: 'running',
      composeServiceName: 'web',
      ordinal: 1,
    })

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'environment.lifecycle',
        payload: {
          environmentId,
          projectId: projectRow!.id,
          projectName: 'tp-demo-lifecycle',
          action: 'stop',
        },
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
          result: {
            projectName: 'tp-demo-lifecycle',
            summary: 'Lifecycle stop',
            containers: [
              {
                composeServiceName: 'web',
                containerId: 'new-cid',
                containerName: 'proj-web-1',
                status: 'exited',
                role: 'service',
              },
            ],
          },
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const updated = await getCommandRecord(db, record.id)
      assertEquals(updated?.status, 'succeeded')

      const [row] = await db
        .select({
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.serverId, serverId))
        .limit(1)
      assertEquals(row?.containerId, 'new-cid')
      assertEquals(row?.status, 'exited')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope skips reconcile when environment.lifecycle omits containers', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Lifecycle Skip Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'Lifecycle Skip Project',
        metadata: { type: 'docker-compose' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Production',
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'web',
      composeServiceName: 'web',
      })
      .returning({ id: service.id })
    await db.insert(container).values({
      serviceId: serviceRow!.id,
      serverId,
      containerId: 'keep-cid',
      containerName: 'proj-web-1',
      status: 'running',
      composeServiceName: 'web',
      ordinal: 1,
    })

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'environment.lifecycle',
        payload: {
          environmentId,
          projectId: projectRow!.id,
          projectName: 'tp-demo-lifecycle',
          action: 'restart',
        },
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
          result: {
            projectName: 'tp-demo-lifecycle',
            summary: 'Lifecycle restart',
          },
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const updated = await getCommandRecord(db, record.id)
      assertEquals(updated?.status, 'succeeded')

      const [row] = await db
        .select({
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.serverId, serverId))
        .limit(1)
      assertEquals(row?.containerId, 'keep-cid')
      assertEquals(row?.status, 'running')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope reconciles containers on system.reconcile success', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'System Reconcile Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'System Reconcile Project',
        metadata: { type: 'docker-compose', component: 'hosting-ingress' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Hosting Ingress',
        metadata: { component: 'hosting-ingress' },
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'traefik',
      composeServiceName: 'traefik',
      })
      .returning({ id: service.id })
    const serviceId = serviceRow!.id
    const containerName = `${serviceId}-in`
    const [containerRow] = await db
      .insert(container)
      .values({
        serviceId,
        serverId,
        containerId: null,
        containerName,
        status: 'pending',
        role: 'ingress',
        composeServiceName: 'traefik',
        ordinal: 1,
      })
      .returning({ id: container.id })
    const containerRowId = containerRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'system.reconcile',
        payload: {
          environmentId,
          action: 'reconcile',
          components: [
            {
              component: 'hosting-ingress',
              serviceId,
              composeServiceName: 'traefik',
              containerName,
              role: 'ingress',
              desired: 'present',
            },
          ],
        },
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
          result: {
            summary: 'System reconcile',
            containers: [
              {
                serviceId,
                composeServiceName: 'traefik',
                containerId: 'ingress-cid-1',
                containerName,
                status: 'running',
                role: 'ingress',
              },
            ],
          },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const updated = await getCommandRecord(db, record.id)
      assertEquals(updated?.status, 'succeeded')

      const [row] = await db
        .select({
          id: container.id,
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.id, containerRowId))
        .limit(1)
      assertEquals(row?.id, containerRowId)
      assertEquals(row?.containerId, 'ingress-cid-1')
      assertEquals(row?.status, 'running')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope skips reconcile when system.reconcile omits containers', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'System Skip Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'System Skip Project',
        metadata: { type: 'docker-compose', component: 'hosting-ingress' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Hosting Ingress',
        metadata: { component: 'hosting-ingress' },
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'traefik',
      composeServiceName: 'traefik',
      })
      .returning({ id: service.id })
    const serviceId = serviceRow!.id
    const containerName = `${serviceId}-in`
    await db.insert(container).values({
      serviceId,
      serverId,
      containerId: 'keep-ingress-cid',
      containerName,
      status: 'running',
      role: 'ingress',
      composeServiceName: 'traefik',
      ordinal: 1,
    })

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'system.reconcile',
        payload: {
          environmentId,
          action: 'reconcile',
          components: [
            {
              component: 'hosting-ingress',
              serviceId,
              composeServiceName: 'traefik',
              containerName,
              role: 'ingress',
              desired: 'present',
            },
          ],
        },
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
          result: { summary: 'inspect failed' },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const [row] = await db
        .select({
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.serverId, serverId))
        .limit(1)
      assertEquals(row?.containerId, 'keep-ingress-cid')
      assertEquals(row?.status, 'running')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope clears pins when system.reconcile reports empty containers', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'System Empty Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'System Empty Project',
        metadata: { type: 'docker-compose', component: 'hosting-ingress' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Hosting Ingress',
        metadata: { component: 'hosting-ingress' },
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'traefik',
      composeServiceName: 'traefik',
      })
      .returning({ id: service.id })
    const serviceId = serviceRow!.id
    const containerName = `${serviceId}-in`
    const [containerRow] = await db
      .insert(container)
      .values({
        serviceId,
        serverId,
        containerId: 'old-ingress-cid',
        containerName,
        status: 'running',
        role: 'ingress',
        composeServiceName: 'traefik',
        ordinal: 1,
      })
      .returning({ id: container.id })
    const containerRowId = containerRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'system.reconcile',
        payload: {
          environmentId,
          action: 'reconcile',
          components: [
            {
              component: 'hosting-ingress',
              serviceId,
              composeServiceName: 'traefik',
              containerName,
              role: 'ingress',
              desired: 'absent',
            },
          ],
        },
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
          result: { summary: 'absent', containers: [] },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const [row] = await db
        .select({
          id: container.id,
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.id, containerRowId))
        .limit(1)
      assertEquals(row?.id, containerRowId)
      assertEquals(row?.containerId, null)
      assertEquals(row?.status, 'exited')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope maps a labelled self-host system.reconcile report onto the pre-allocated system row by service UUID container name', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Self-Host Reconcile Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'TurboPanel',
        metadata: { type: 'docker-compose', component: 'turbopanel' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Production',
        metadata: { component: 'turbopanel' },
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'database',
      composeServiceName: 'database',
      })
      .returning({ id: service.id })
    const serviceId = serviceRow!.id
    // Self-host system containers use bare uuid naming — the service id itself,
    // never the `<serviceId>-in` shape used by hosting-ingress.
    const containerName = serviceId
    const [containerRow] = await db
      .insert(container)
      .values({
        serviceId,
        serverId,
        containerId: null,
        containerName,
        status: 'pending',
        role: 'system',
        composeServiceName: 'database',
        ordinal: 1,
      })
      .returning({ id: container.id })
    const containerRowId = containerRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'system.reconcile',
        payload: {
          environmentId,
          action: 'reconcile',
          components: [
            {
              component: 'database',
              serviceId,
              composeServiceName: 'database',
              containerName,
              role: 'system',
              desired: 'present',
            },
          ],
        },
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
          result: {
            summary: 'System reconcile',
            containers: [
              {
                serviceId,
                composeServiceName: 'database',
                containerId: 'db-cid-1',
                containerName,
                status: 'running',
                role: 'system',
              },
            ],
          },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const updated = await getCommandRecord(db, record.id)
      assertEquals(updated?.status, 'succeeded')

      const [row] = await db
        .select({
          id: container.id,
          containerId: container.containerId,
          containerName: container.containerName,
          status: container.status,
          role: container.role,
        })
        .from(container)
        .where(eq(container.id, containerRowId))
        .limit(1)
      assertEquals(row?.id, containerRowId)
      assertEquals(row?.containerId, 'db-cid-1')
      assertEquals(row?.containerName, serviceId)
      assertEquals(row?.status, 'running')
      assertEquals(row?.role, 'system')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope leaves a missing self-host system container exited with null Docker id and preserves the row id', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Self-Host Missing Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'TurboPanel',
        metadata: { type: 'docker-compose', component: 'turbopanel' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Production',
        metadata: { component: 'turbopanel' },
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'queue',
      composeServiceName: 'queue',
      })
      .returning({ id: service.id })
    const serviceId = serviceRow!.id
    const containerName = serviceId
    const [containerRow] = await db
      .insert(container)
      .values({
        serviceId,
        serverId,
        containerId: 'stale-queue-cid',
        containerName,
        status: 'running',
        role: 'system',
        composeServiceName: 'queue',
        ordinal: 1,
      })
      .returning({ id: container.id })
    const containerRowId = containerRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'system.reconcile',
        payload: {
          environmentId,
          action: 'reconcile',
          components: [
            {
              component: 'queue',
              serviceId,
              composeServiceName: 'queue',
              containerName,
              role: 'system',
              desired: 'present',
            },
          ],
        },
      })

      // Authoritative empty report: the daemon compose-ps'd the project and
      // found no matching row (container missing / crashed) — never a
      // collection failure, which would omit `containers` entirely instead.
      const registry = createDispatchMockRegistry(serverId, {
        waitForRequestResult: {
          serverId,
          requestId: record.id,
          requestKind: 'command-dispatch',
          status: 'done',
          createdAt: record.createdAt,
          expiresAt: record.createdAt,
          finishedAt: new Date().toISOString(),
          result: { summary: 'not observed', containers: [] },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const [row] = await db
        .select({
          id: container.id,
          containerId: container.containerId,
          containerName: container.containerName,
          status: container.status,
        })
        .from(container)
        .where(eq(container.id, containerRowId))
        .limit(1)
      assertEquals(row?.id, containerRowId)
      assertEquals(row?.containerId, null)
      assertEquals(row?.containerName, serviceId)
      assertEquals(row?.status, 'exited')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope keeps unmatched self-host expected rows on partial system.reconcile report', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Self-Host Partial Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'TurboPanel',
        metadata: { type: 'docker-compose', component: 'turbopanel' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Production',
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id

    const composeNames = ['database', 'queue', 'analytics'] as const
    const serviceIds: string[] = []
    const containerRowIds: string[] = []
    for (const composeServiceName of composeNames) {
      const [serviceRow] = await db
        .insert(service)
        .values({
          environmentId,
          name: composeServiceName,
          composeServiceName,
        })
        .returning({ id: service.id })
      const serviceId = serviceRow!.id
      serviceIds.push(serviceId)
      const [containerRow] = await db
        .insert(container)
        .values({
          serviceId,
          serverId,
          containerId: `stale-${composeServiceName}`,
          containerName: serviceId,
          status: 'running',
          role: 'system',
          composeServiceName,
          ordinal: 1,
        })
        .returning({ id: container.id })
      containerRowIds.push(containerRow!.id)
    }

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'system.reconcile',
        payload: {
          environmentId,
          action: 'reconcile',
          components: composeNames.map((composeServiceName, index) => ({
            component: composeServiceName,
            serviceId: serviceIds[index]!,
            composeServiceName,
            containerName: serviceIds[index]!,
            role: 'system' as const,
            desired: 'present' as const,
          })),
        },
      })

      // Daemon reports only database running — queue/analytics must remain
      // with the same row ids and null Docker ids (not deleted).
      const registry = createDispatchMockRegistry(serverId, {
        waitForRequestResult: {
          serverId,
          requestId: record.id,
          requestKind: 'command-dispatch',
          status: 'done',
          createdAt: record.createdAt,
          expiresAt: record.createdAt,
          finishedAt: new Date().toISOString(),
          result: {
            summary: 'partial',
            containers: [
              {
                serviceId: serviceIds[0]!,
                composeServiceName: 'database',
                containerId: 'db-only-cid',
                containerName: serviceIds[0]!,
                status: 'running',
                role: 'system',
              },
            ],
          },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const rows = await db
        .select({
          id: container.id,
          serviceId: container.serviceId,
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.serverId, serverId))

      assertEquals(rows.length, 3)
      const byService = new Map(rows.map((row) => [row.serviceId, row]))
      assertEquals(byService.get(serviceIds[0]!)?.id, containerRowIds[0])
      assertEquals(byService.get(serviceIds[0]!)?.containerId, 'db-only-cid')
      assertEquals(byService.get(serviceIds[0]!)?.status, 'running')
      assertEquals(byService.get(serviceIds[1]!)?.id, containerRowIds[1])
      assertEquals(byService.get(serviceIds[1]!)?.containerId, null)
      assertEquals(byService.get(serviceIds[1]!)?.status, 'exited')
      assertEquals(byService.get(serviceIds[2]!)?.id, containerRowIds[2])
      assertEquals(byService.get(serviceIds[2]!)?.containerId, null)
      assertEquals(byService.get(serviceIds[2]!)?.status, 'exited')
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
})

test('processCommandEnvelope no-ops when command record is missing', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })

    await processCommandEnvelope(db, registry, {
      commandId: '00000000-0000-4000-8000-000000000099',
      serverId,
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: new Date().toISOString(),
    })

    assertEquals(registry.enqueueCalled, false)
  })
})

test('processCommandEnvelope no-ops when envelope serverId mismatches record', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })

    await processCommandEnvelope(db, registry, {
      ...buildEnvelope(record, serverId),
      serverId: '00000000-0000-4000-8000-000000000099',
    })

    assertEquals(registry.enqueueCalled, false)
    const unchanged = await getCommandRecord(db, record.id)
    assertEquals(unchanged?.status, 'queued')
  })
})

test('processCommandEnvelope merges NTP facts into server.metadata.timeSync on success', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.ntp.set',
      payload: {
        enabled: true,
        servers: ['time.cloudflare.com'],
      },
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
        result: {
          ntpEnabled: true,
          ntpSynced: true,
          ntpServers: ['time.cloudflare.com'],
          fallbackNtpServers: ['pool.ntp.org'],
        },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ metadata: server.metadata })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const timeSync = (row?.metadata as Record<string, unknown>).timeSync as
      | Record<string, unknown>
      | undefined
    assertEquals(timeSync?.ntpEnabled, true)
    assertEquals(timeSync?.ntpSynced, true)
    assertEquals(timeSync?.ntpServers, ['time.cloudflare.com'])
    assertEquals(timeSync?.fallbackNtpServers, ['pool.ntp.org'])
    assertEquals(typeof timeSync?.capturedAt, 'string')
  })
})

async function withDeployFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
    environmentId: string
    projectId: string
    webServiceId: string
  }) => Promise<void>,
): Promise<void> {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    const [workspaceRow] = await db
      .insert(workspace)
      .values({ organizationId, name: 'Deploy Consumer Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        name: 'Deploy Consumer Project',
        metadata: { type: 'docker-compose' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'Production',
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'web',
      composeServiceName: 'web',
      })
      .returning({ id: service.id })

    try {
      await fn({
        db,
        organizationId,
        serverId,
        environmentId,
        projectId: projectRow!.id,
        webServiceId: serviceRow!.id,
      })
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.environmentId, environmentId))
      await db.delete(environment).where(eq(environment.id, environmentId))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
}

const MANAGED_APPLY_PAYLOAD = {
  engine: 'postgres',
  projectName: 'tp-managed-pg',
  containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-1',
  image: 'docker.io/library/postgres:18-alpine',
  containerPort: 5432,
  composeYaml: 'services:\n  postgres:\n    image: postgres:18-alpine\n',
  configFiles: [
    { path: 'postgresql.conf', contents: "listen_addresses = '*'\n", mode: '0640' },
    {
      path: 'pg_hba.conf',
      contents:
        '# TurboPanel managed PostgreSQL — platform pg_hba\nlocal all all peer\n',
      mode: '0640',
    },
  ],
  volumes: [{ name: 'pgdata', target: '/var/lib/postgresql' }],
  exposure: { enabled: false, protocol: 'tcp' },
  memberId: '00000000-0000-4000-8000-0000000000aa',
  memberRole: 'primary' as const,
  memberOrdinal: 1,
  readEligible: true,
  peers: [] as const,
  credentials: [
    {
      principalId: '00000000-0000-4000-8000-000000000003',
      username: 'postgres',
      role: 'root',
      databases: ['postgres'],
      password: 'denc.server.key.1.payload',
    },
  ],
} as const

async function withManagedApplyFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    serverId: string
    managedId: string
    environmentId: string
    serviceId: string
  }) => Promise<void>,
): Promise<void> {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const [managedRow] = await db
      .select({ environmentId: managed.environmentId })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    const environmentId = managedRow!.environmentId
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'postgres',
      composeServiceName: 'postgres',
      })
      .returning({ id: service.id })

    try {
      await fn({
        db,
        serverId,
        managedId,
        environmentId,
        serviceId: serviceRow!.id,
      })
    } finally {
      await db.delete(container).where(eq(container.serverId, serverId))
      await db.delete(service).where(eq(service.id, serviceRow!.id))
    }
  })
}

test('processCommandEnvelope reconciles containers on environment.deploy success', async () => {
  await withDeployFixtures(async ({
    db,
    organizationId,
    serverId,
    environmentId,
    projectId,
    webServiceId,
  }) => {
    await attachConnectedDaemonStatus(db, serverId)
    await db.insert(container).values({
      serviceId: webServiceId,
      serverId,
      containerId: null,
      containerName: 'proj-web-1',
      status: 'pending',
      composeServiceName: 'web',
      ordinal: 1,
    })

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'environment.deploy',
      payload: {
        environmentId,
        projectId,
        organizationId,
        projectName: 'tp-deploy-test',
        composeYaml: 'services:\n  web:\n    image: nginx\n',
        hostings: [],
      },
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
        result: {
          projectName: 'tp-deploy-test',
          summary: 'deployed',
          containers: [
            {
              composeServiceName: 'web',
              containerId: 'deploy-cid',
              containerName: 'proj-web-1',
              status: 'running',
              role: 'service',
            },
          ],
        },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ containerId: container.containerId, status: container.status })
      .from(container)
      .where(eq(container.serviceId, webServiceId))
      .limit(1)
    assertEquals(row?.containerId, 'deploy-cid')
    assertEquals(row?.status, 'running')
  })
})

test('processCommandEnvelope clears pins on environment.stop success', async () => {
  await withDeployFixtures(async ({
    db,
    serverId,
    environmentId,
    projectId,
    webServiceId,
  }) => {
    await attachConnectedDaemonStatus(db, serverId)
    await db.insert(container).values({
      serviceId: webServiceId,
      serverId,
      containerId: 'running-cid',
      containerName: 'proj-web-1',
      status: 'running',
      composeServiceName: 'web',
      ordinal: 1,
    })

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'environment.stop',
      payload: {
        environmentId,
        projectId,
        projectName: 'tp-stop-test',
      },
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
        result: {
          projectName: 'tp-stop-test',
          summary: 'stopped',
          containers: [],
        },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ containerId: container.containerId, status: container.status })
      .from(container)
      .where(eq(container.serviceId, webServiceId))
      .limit(1)
    assertEquals(row?.containerId, null)
    assertEquals(row?.status, 'exited')
  })
})

test('processCommandEnvelope projects managed.apply onto managed row and reconciles containers', async () => {
  await withManagedApplyFixtures(async ({
    db,
    serverId,
    managedId,
    environmentId,
    serviceId,
  }) => {
    await db.insert(container).values({
      serviceId,
      serverId,
      containerId: null,
      containerName: MANAGED_APPLY_PAYLOAD.containerName,
      status: 'pending',
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.apply',
      payload: {
        managedId,
        environmentId,
        ...MANAGED_APPLY_PAYLOAD,
      },
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
        result: {
          host: '203.0.113.10',
          port: 5432,
          containers: [
            {
              serviceId,
              composeServiceName: 'postgres',
              containerId: 'managed-cid',
              containerName: MANAGED_APPLY_PAYLOAD.containerName,
              status: 'running',
              role: 'service',
            },
          ],
        },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ status: managed.status, metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'ready')
    assertEquals(
      (managedRow?.metadata as { host?: string; port?: number }).host,
      '203.0.113.10',
    )
    assertEquals(
      (managedRow?.metadata as { host?: string; port?: number }).port,
      5432,
    )

    const [containerRow] = await db
      .select({ containerId: container.containerId, status: container.status })
      .from(container)
      .where(eq(container.serviceId, serviceId))
      .limit(1)
    assertEquals(containerRow?.containerId, 'managed-cid')
    assertEquals(containerRow?.status, 'running')
  })
})

test('processCommandEnvelope keeps primary pin when replica managed.apply succeeds', async () => {
  await withManagedApplyFixtures(async ({
    db,
    serverId,
    managedId,
    environmentId,
    serviceId,
  }) => {
    const primaryServerId = serverId
    const [primaryRow] = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, primaryServerId))
      .limit(1)
    const now = new Date().toISOString()
    const [replicaServer] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: primaryRow!.organizationId!,
        name: 'Replica Host',
      })
      .returning({ id: server.id })
    const replicaServerId = replicaServer!.id

    try {
      await attachConnectedDaemonStatus(db, replicaServerId)

      await db
        .update(managed)
        .set({
          serverId: primaryServerId,
          metadata: { host: '203.0.113.1', port: 5432 },
          status: 'applying',
        })
        .where(eq(managed.id, managedId))

      await db.insert(container).values({
        serviceId,
        serverId: replicaServerId,
        containerId: null,
        containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-2',
        status: 'pending',
        composeServiceName: 'postgres',
        ordinal: 2,
      })

      const record = await createCommandRecord(db, {
        serverId: replicaServerId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.apply',
        payload: {
          managedId,
          environmentId,
          ...MANAGED_APPLY_PAYLOAD,
          containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-2',
          memberId: '00000000-0000-4000-8000-0000000000bb',
          memberRole: 'replica',
          memberOrdinal: 2,
        },
      })

      const registry = createDispatchMockRegistry(replicaServerId, {
        waitForRequestResult: {
          serverId: replicaServerId,
          requestId: record.id,
          requestKind: 'command-dispatch',
          status: 'done',
          createdAt: record.createdAt,
          expiresAt: record.createdAt,
          finishedAt: new Date().toISOString(),
          result: {
            host: '203.0.113.99',
            port: 6543,
            containers: [
              {
                serviceId,
                composeServiceName: 'postgres',
                containerId: 'replica-cid',
                containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-2',
                status: 'running',
                role: 'service',
              },
            ],
          },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, replicaServerId),
      )

      const [managedRow] = await db
        .select({
          status: managed.status,
          serverId: managed.serverId,
          metadata: managed.metadata,
        })
        .from(managed)
        .where(eq(managed.id, managedId))
        .limit(1)
      assertEquals(managedRow?.status, 'ready')
      assertEquals(managedRow?.serverId, primaryServerId)
      assertEquals(
        (managedRow?.metadata as { host?: string; port?: number }).host,
        '203.0.113.1',
      )
      assertEquals(
        (managedRow?.metadata as { host?: string; port?: number }).port,
        5432,
      )

      const [containerRow] = await db
        .select({ containerId: container.containerId, status: container.status })
        .from(container)
        .where(eq(container.ordinal, 2))
        .limit(1)
      assertEquals(containerRow?.containerId, 'replica-cid')
      assertEquals(containerRow?.status, 'running')
    } finally {
      await db.delete(command).where(eq(command.serverId, replicaServerId))
      await db.delete(container).where(eq(container.serverId, replicaServerId))
      await db.delete(server).where(eq(server.id, replicaServerId))
    }
  })
})

test('processCommandEnvelope projects managed.lifecycle status from daemon result', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.lifecycle',
      payload: { managedId, action: 'stop' },
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
        result: { status: 'stopped' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'stopped')
  })
})

test('processCommandEnvelope appends managed.backup metadata on create success', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({
        options: { settings: {}, databases: ['postgres'], backups: [] },
      })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.backup',
      payload: {
        managedId,
        engine: 'postgres',
        action: 'create',
        backupId: 'bk_1700000000000',
        artifactExtension: 'dump',
        scope: 'database',
        database: 'postgres',
      },
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
        result: {
          backupId: 'bk_1700000000000',
          path: '/var/lib/turbopanel/backups/bk_1700000000000.dump',
          sizeBytes: 4096,
          checksum: 'a'.repeat(64),
          database: 'postgres',
          completedAt: '2020-01-01T00:00:00.000Z',
        },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ options: managed.options })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    const backups = (managedRow?.options as { backups?: unknown[] }).backups
    assertEquals(Array.isArray(backups), true)
    assertEquals((backups as { id: string }[])[0]?.id, 'bk_1700000000000')
  })
})

test('processCommandEnvelope sets managed.status ready on managed.restore success', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({ status: 'applying' })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.restore',
      payload: {
        managedId,
        engine: 'postgres',
        backupId: 'bk_1700000000000',
        artifactExtension: 'dump',
        checksum: 'c'.repeat(64),
      },
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
        result: { summary: 'restored' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'ready')
  })
})

test('processCommandEnvelope marks managed failed when managed.apply times out', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({ status: 'applying' })
      .where(eq(managed.id, managedId))

    const [managedRow] = await db
      .select({ environmentId: managed.environmentId })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.apply',
      payload: {
        managedId,
        environmentId: managedRow!.environmentId,
        ...MANAGED_APPLY_PAYLOAD,
      },
    })

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'timed_out')

    const [afterManaged] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(afterManaged?.status, 'failed')
  })
})

test('processCommandEnvelope leaves managed.status unchanged when managed.backup fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({ status: 'ready' })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.backup',
      payload: {
        managedId,
        engine: 'postgres',
        action: 'create',
        backupId: 'bk_1700000000000',
        artifactExtension: 'dump',
        scope: 'database',
        database: 'postgres',
      },
    })

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'failed',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        error: 'backup engine unavailable',
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'ready')
  })
})

test('isTransientError matches Error names for timeout network connection', () => {
  assertEquals(
    isTransientError(Object.assign(new Error('ignored'), { name: 'TimeoutError' })),
    true,
  )
  assertEquals(
    isTransientError(Object.assign(new Error('ignored'), { name: 'NetworkError' })),
    true,
  )
  assertEquals(
    isTransientError(Object.assign(new Error('ignored'), { name: 'ConnectionError' })),
    true,
  )
})

test('processCommandEnvelope enriches ping result with cellDispatchedAt', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const sentAt = '2020-01-01T00:00:00.000Z'
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'done',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        finishedAt: new Date().toISOString(),
        sentAt,
        result: { ok: true, latencyMs: 12 },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')
    assertEquals(
      (updated?.result as Record<string, unknown>).cellDispatchedAt,
      sentAt,
    )
  })
})

test('processCommandEnvelope skips hostname metadata when result omits observedHostname', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const now = new Date().toISOString()
    await db.update(server).set({
      hostname: 'before-hostname',
      updatedAt: now,
    }).where(eq(server.id, serverId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.hostname.set',
      payload: { hostname: 'after-hostname' },
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
        result: { summary: 'hostname unchanged' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ hostname: server.hostname })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals(row?.hostname, 'before-hostname')
  })
})

test('processCommandEnvelope leaves timezone options unchanged on malformed timezone success', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const now = new Date().toISOString()
    await db.update(server).set({
      options: { timezone: 'UTC' },
      updatedAt: now,
    }).where(eq(server.id, serverId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.timezone.set',
      payload: { timezone: 'America/Chicago' },
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
        result: { timezone: '' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db
      .select({ options: server.options })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals((row?.options as { timezone?: string }).timezone, 'UTC')
  })
})

test('processCommandEnvelope maps expired pending requests to timed_out', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'expired',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'timed_out')
  })
})

test('processCommandEnvelope fails on unexpected pending request status', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'acked',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
    assertEquals(
      updated?.error,
      'Unexpected pending request status: acked',
    )
  })
})

test('processCommandEnvelope marks managed failed when lifecycle pending expires', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({ status: 'applying' })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.lifecycle',
      payload: { managedId, action: 'stop' },
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'expired',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'timed_out')
    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'failed')
  })
})

test('processCommandEnvelope marks managed failed when lifecycle command fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({ status: 'ready' })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.lifecycle',
      payload: { managedId, action: 'stop' },
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'failed',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        error: 'compose stop failed',
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'failed')
  })
})

test('processCommandEnvelope ignores non-projectable managed lifecycle status', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({ status: 'ready' })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.lifecycle',
      payload: { managedId, action: 'start' },
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
        result: { status: 'provisioning' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'ready')
  })
})

test('processCommandEnvelope removes backup metadata on managed.backup delete success', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({
        options: {
          settings: {},
          databases: ['postgres'],
          backups: [{
            id: 'bk_1700000000000',
            createdAt: '2020-01-01T00:00:00.000Z',
            sizeBytes: 1024,
            checksum: 'a'.repeat(64),
            path: '/var/lib/turbopanel/backups/bk_1700000000000.dump',
          }],
        },
      })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.backup',
      payload: {
        managedId,
        engine: 'postgres',
        action: 'delete',
        backupId: 'bk_1700000000000',
        artifactExtension: 'dump',
        scope: 'database',
        database: 'postgres',
      },
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
        result: { backupId: 'bk_1700000000000', deleted: true },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ options: managed.options })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    const backups = (managedRow?.options as { backups?: unknown[] }).backups
    assertEquals(backups, [])
  })
})

test('processCommandEnvelope skips reconcile when environment.deploy omits containers', async () => {
  await withDeployFixtures(async ({ db, serverId, environmentId, webServiceId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'environment.deploy',
      payload: { environmentId },
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
        result: { summary: 'deployed without ps report' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const rows = await db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.serviceId, webServiceId))
    assertEquals(rows.length, 0)
  })
})

test('processCommandEnvelope swallows deploy side-effect parse errors after success', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'environment.deploy',
      payload: { notAnEnvironmentId: true },
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
        result: { containers: [] },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')
  })
})

test('processCommandEnvelope swallows managed.apply side-effect errors after success', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.apply',
      payload: {
        managedId,
        environmentId: 'not-a-uuid',
        engine: 'postgres',
      },
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
        result: { host: '203.0.113.10', port: 5432 },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')
    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'ready')
  })
})

test('processCommandEnvelope leaves managed.status unchanged when managed.restore side effect fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db
      .update(managed)
      .set({ status: 'applying' })
      .where(eq(managed.id, managedId))

    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.restore',
      payload: { managedId, engine: 'postgres' },
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
        result: { summary: 'restored' },
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [managedRow] = await db
      .select({ status: managed.status })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'applying')
  })
})

test('processCommandEnvelope demotes old primary before promote so uniq_node_primary holds', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    // Second server for the standby that will be promoted.
    const [standbyServer] = await db
      .insert(server)
      .values({
        organizationId: (
          await db
            .select({ organizationId: server.organizationId })
            .from(server)
            .where(eq(server.id, serverId))
            .limit(1)
        )[0]!.organizationId,
        name: 'standby-host',
        hostname: 'standby-host',
      })
      .returning({ id: server.id })
    const standbyServerId = standbyServer!.id
    await attachConnectedDaemonStatus(db, standbyServerId)

    const [primaryMember] = await db
      .insert(node)
      .values({
        managedId,
        serverId,
        role: 'primary',
        ordinal: 1,
        status: 'ready',
      })
      .returning({ id: node.id })
    const [replicaMember] = await db
      .insert(node)
      .values({
        managedId,
        serverId: standbyServerId,
        role: 'replica',
        ordinal: 2,
        status: 'ready',
      })
      .returning({ id: node.id })

    try {
      const record = await createCommandRecord(db, {
        serverId: standbyServerId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.promote',
        payload: {
          managedId,
          memberId: replicaMember!.id,
          demoteMemberId: primaryMember!.id,
        },
      })

      const registry = createDispatchMockRegistry(standbyServerId, {
        waitForRequestResult: {
          serverId: standbyServerId,
          requestId: record.id,
          requestKind: 'command-dispatch',
          status: 'done',
          createdAt: record.createdAt,
          expiresAt: record.createdAt,
          finishedAt: new Date().toISOString(),
          result: {
            promotedMemberId: replicaMember!.id,
            demotedMemberId: primaryMember!.id,
            status: 'ready',
            summary: 'promoted',
          },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, standbyServerId),
      )

      const members = await db
        .select({
          id: node.id,
          role: node.role,
          status: node.status,
        })
        .from(node)
        .where(eq(node.managedId, managedId))

      const primary = members.find((m) => m.id === primaryMember!.id)
      const replica = members.find((m) => m.id === replicaMember!.id)
      assertEquals(primary?.role, 'replica')
      assertEquals(primary?.status, 'needs_resync')
      assertEquals(replica?.role, 'primary')
      assertEquals(replica?.status, 'ready')

      const [managedRow] = await db
        .select({ serverId: managed.serverId, status: managed.status })
        .from(managed)
        .where(eq(managed.id, managedId))
        .limit(1)
      assertEquals(managedRow?.serverId, standbyServerId)
      assertEquals(managedRow?.status, 'ready')
    } finally {
      await db.delete(node).where(eq(node.managedId, managedId))
      // Promote may have flipped managed.serverId to the standby host; point
      // it back at the original server before dropping the standby row so
      // the FK doesn't block deletion.
      await db.update(managed).set({ serverId }).where(eq(managed.id, managedId))
      await db.delete(command).where(eq(command.serverId, standbyServerId))
      await db.delete(server).where(eq(server.id, standbyServerId))
    }
  })
})

function createRecordingCommandQueue() {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: async (envelope: CommandEnvelope) => {
      envelopes.push(envelope)
    },
  }
}

test('processCommandEnvelope enqueues pendingStandbyApplies only after primary succeeds', async () => {
  await withManagedApplyFixtures(async ({
    db,
    serverId,
    managedId,
    environmentId,
    serviceId,
  }) => {
    await db.insert(container).values({
      serviceId,
      serverId,
      containerId: null,
      containerName: MANAGED_APPLY_PAYLOAD.containerName,
      status: 'pending',
      composeServiceName: 'postgres',
      ordinal: 1,
    })

    const [primaryServerRow] = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const now = new Date().toISOString()
    const [standbyServerRow] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: primaryServerRow!.organizationId,
        name: 'Standby Apply Test Server',
      })
      .returning({ id: server.id })
    const standbyServerId = standbyServerRow!.id
    const standbyMemberId = '00000000-0000-4000-8000-0000000000bb'
    const standbyPayload = {
      managedId,
      environmentId,
      ...MANAGED_APPLY_PAYLOAD,
      memberId: standbyMemberId,
      memberRole: 'replica' as const,
      memberOrdinal: 2,
      containerName: '01936b3e-aaaa-bbbb-cccc-123456789abc-2',
    }

    const queue = createRecordingCommandQueue()
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.apply',
      payload: {
        managedId,
        environmentId,
        ...MANAGED_APPLY_PAYLOAD,
      },
      metadata: {
        pendingStandbyApplies: [
          {
            serverId: standbyServerId,
            memberId: standbyMemberId,
            payload: standbyPayload,
          },
        ],
      },
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
        result: {
          host: '203.0.113.10',
          port: 5432,
          containers: [
            {
              serviceId,
              composeServiceName: 'postgres',
              containerId: 'managed-cid',
              containerName: MANAGED_APPLY_PAYLOAD.containerName,
              status: 'running',
              role: 'service',
            },
          ],
        },
      },
    })

    await processCommandEnvelope(
      db,
      registry,
      buildEnvelope(record, serverId),
      { commandQueue: queue },
    )

    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]?.type, 'managed.apply')
    assertEquals(queue.envelopes[0]?.serverId, standbyServerId)

    await db.delete(command).where(eq(command.serverId, standbyServerId))
    await db.delete(server).where(eq(server.id, standbyServerId))
  })
})

test('processCommandEnvelope does not enqueue standbys when primary apply fails', async () => {
  await withManagedApplyFixtures(async ({
    db,
    serverId,
    managedId,
    environmentId,
  }) => {
    const standbyServerId = crypto.randomUUID()
    const standbyPayload = {
      managedId,
      environmentId,
      ...MANAGED_APPLY_PAYLOAD,
      memberId: '00000000-0000-4000-8000-0000000000bb',
      memberRole: 'replica' as const,
      memberOrdinal: 2,
    }
    const queue = createRecordingCommandQueue()
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.apply',
      payload: {
        managedId,
        environmentId,
        ...MANAGED_APPLY_PAYLOAD,
      },
      metadata: {
        pendingStandbyApplies: [
          {
            serverId: standbyServerId,
            memberId: standbyPayload.memberId,
            payload: standbyPayload,
          },
        ],
      },
    })

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'failed',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        finishedAt: new Date().toISOString(),
        error: 'apply boom',
      },
    })

    await processCommandEnvelope(
      db,
      registry,
      buildEnvelope(record, serverId),
      { commandQueue: queue },
    )

    assertEquals(queue.envelopes.length, 0)
    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
  })
})

test('processCommandEnvelope enqueues promote only after successful fence lifecycle', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const [primaryServerRow] = await db
      .select({ organizationId: server.organizationId })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const now = new Date().toISOString()
    const [promoteServerRow] = await db
      .insert(server)
      .values({
        createdAt: now,
        updatedAt: now,
        organizationId: primaryServerRow!.organizationId,
        name: 'Promote Follow-up Test Server',
      })
      .returning({ id: server.id })
    const promoteServerId = promoteServerRow!.id
    const queue = createRecordingCommandQueue()
    const promotePayload = {
      managedId,
      memberId: '00000000-0000-4000-8000-0000000000cc',
      engine: 'postgres',
      demoteMemberId: '00000000-0000-4000-8000-0000000000aa',
    }
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.lifecycle',
      payload: { managedId, action: 'stop', engine: 'postgres' },
      metadata: {
        followUpPromote: {
          serverId: promoteServerId,
          payload: promotePayload,
        },
      },
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
        result: { status: 'stopped' },
      },
    })

    await processCommandEnvelope(
      db,
      registry,
      buildEnvelope(record, serverId),
      { commandQueue: queue },
    )

    assertEquals(queue.envelopes.length, 1)
    assertEquals(queue.envelopes[0]?.type, 'managed.promote')
    assertEquals(queue.envelopes[0]?.serverId, promoteServerId)

    await db.delete(command).where(eq(command.serverId, promoteServerId))
    await db.delete(server).where(eq(server.id, promoteServerId))
  })
})

test('processCommandEnvelope does not enqueue promote when fence lifecycle fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const queue = createRecordingCommandQueue()
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.lifecycle',
      payload: { managedId, action: 'stop', engine: 'postgres' },
      metadata: {
        followUpPromote: {
          serverId: crypto.randomUUID(),
          payload: {
            managedId,
            memberId: '00000000-0000-4000-8000-0000000000cc',
            engine: 'postgres',
          },
        },
      },
    })

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'failed',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        finishedAt: new Date().toISOString(),
        error: 'fence failed',
      },
    })

    await processCommandEnvelope(
      db,
      registry,
      buildEnvelope(record, serverId),
      { commandQueue: queue },
    )

    assertEquals(queue.envelopes.length, 0)
  })
})

test('processCommandEnvelope deletes member only after destroy success with deleteMemberAfterDestroy', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const [memberRow] = await db
      .insert(node)
      .values({
        managedId,
        serverId,
        role: 'replica',
        ordinal: 2,
        status: 'applying',
        readEligible: true,
      })
      .returning({ id: node.id })
    const memberId = memberRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.destroy',
        payload: {
          managedId,
          removeVolumes: true,
          memberId,
          deleteMemberAfterDestroy: true,
        },
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
          result: { status: 'stopped', containers: [] },
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const [after] = await db
        .select({ id: node.id })
        .from(node)
        .where(eq(node.id, memberId))
        .limit(1)
      assertEquals(after, undefined)
    } finally {
      await db.delete(node).where(eq(node.managedId, managedId))
    }
  })
})

test('processCommandEnvelope keeps member row failed/retryable when destroy fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const [memberRow] = await db
      .insert(node)
      .values({
        managedId,
        serverId,
        role: 'replica',
        ordinal: 2,
        status: 'applying',
        readEligible: true,
      })
      .returning({ id: node.id })
    const memberId = memberRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.destroy',
        payload: {
          managedId,
          removeVolumes: true,
          memberId,
          deleteMemberAfterDestroy: true,
        },
      })

      const registry = createDispatchMockRegistry(serverId, {
        waitForRequestResult: {
          serverId,
          requestId: record.id,
          requestKind: 'command-dispatch',
          status: 'failed',
          createdAt: record.createdAt,
          expiresAt: record.createdAt,
          finishedAt: new Date().toISOString(),
          error: 'destroy boom',
        },
      })

      await processCommandEnvelope(
        db,
        registry,
        buildEnvelope(record, serverId),
      )

      const [after] = await db
        .select({ id: node.id, status: node.status })
        .from(node)
        .where(eq(node.id, memberId))
        .limit(1)
      assertEquals(after?.id, memberId)
      assertEquals(after?.status, 'failed')
    } finally {
      await db.delete(node).where(eq(node.managedId, managedId))
    }
  })
})
