import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../../daemon/cell/contracts.ts'
import { attachDaemonStateToServer } from '../../daemon/authn/server-identity-db.ts'
import {
  command,
  environment,
  ip,
  managed,
  organization,
  peer,
  principal,
  project,
  server,
  vpn,
  workspace,
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
    assertEquals(
      (row?.metadata as Record<string, unknown>).timeSync,
      { timezone: 'America/Chicago' },
    )
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
      displayName: 'Consumer Mesh',
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
      .values({ organizationId, displayName: 'Managed Destroy Test Workspace' })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        displayName: 'Managed Destroy Test Project',
        metadata: { type: 'managed' },
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        displayName: 'Production',
      })
      .returning({ id: environment.id })
    const [managedRow] = await db
      .insert(managed)
      .values({
        environmentId: environmentRow!.id,
        serverId,
        displayName: 'Managed Destroy Test Postgres',
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
