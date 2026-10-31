import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { DENY_FIREWALL_APPLY } from '../firewall/enforcement.ts'
import { assertEquals, assertRejects } from '@std/assert'
import { stub } from '@std/testing/mock'
import { projectServerDaemon } from '../../daemon/cell/postgres-projection.ts'
import { eq, inArray, sql } from 'drizzle-orm'
import { loadDeployRunCapMs } from './deploy-wait-settings.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, type Db, endDbConnection } from '../../db/connection.ts'
import type { DaemonCell, DaemonCellRegistry, PendingRequestRecord } from '../../contracts/cell.ts'
import { attachDaemonStateToServer } from '../servers/server-identity-db.ts'
import {
  type DerivedSecretsConfig,
  deriveEncryptionSecretsConfig,
  type SecretsConfig,
} from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  backup,
  binding,
  command,
  container,
  datacenter,
  deployment,
  dispatch,
  environment,
  fabric,
  folder,
  ip,
  managed,
  network,
  organization,
  login,
  managedDatabase,
  principal,
  principalPlacement,
  project,
  recovery as recoveryTable,
  replica,
  server,
  service,
  storage,
  storageCopy,
  tls,
  variable,
  workspace,
} from '../../db/schema.ts'
import { createManagedLogin } from '../managed/logins.ts'
import { loadPrimaryEpoch } from '../managed/primary-epoch.ts'
import { RESEED_GUARD_METADATA_KEY } from '../managed/reseed-guard.ts'
import { findRecoveryById, insertRecovery } from '../managed/recovery-records.ts'
import { evaluateFinalPosition } from '../managed/switchover-evidence.ts'
import { ensureManagedIngressHierarchy } from '../system/hierarchy.ts'
import {
  COMMAND_DISPATCH_FAILURE_RETENTION_MS,
  type CommandRecord,
  createCommandRecord,
  deleteCommandDispatch,
  getCommandDispatchPayload,
  getCommandRecord,
  sweepExpiredCommandDispatch,
  transitionCommand,
} from './command-records.ts'
import { enableOrganizationFabric, listFabricRelays } from '../fabric/fabric-records.ts'
import { environmentHasFolders, listEnvironmentFolders } from '../folders/records.ts'
import { deleteProjectCascade } from '../projects/project-delete.ts'
import {
  type DispatchableCommandRecord,
  isTransientError,
  markPlannedFoldersPresentSafely,
  lifecycleFallbackMemberStatus,
  oldPrimaryFinalFromStop,
  processCommandEnvelope,
} from './consumer.ts'
import {
  type ManagedLifecycleCommandResult,
  parseManagedLifecyclePayload,
} from '../../contracts/commands/schemas.ts'
import type { CommandEnvelope } from './envelope.ts'
import { markCommandContactLost, recordCommandProgress } from './command-progress.ts'
import {
  ackForReportedOutcome,
  LATE_OUTCOME_NOTE,
  noteReportedCommands,
  settleReportedOutcome,
} from './command-recovery.ts'
import { touchServerMetadata } from '../servers/server-registry.ts'
import { dispatchDaemonInboundMessage } from '../../daemon/deno-ws.ts'
import type { CommandQueue } from './queue.ts'
import { parseManagedResidual } from '../managed/serialize.ts'
import { resolveFleetPresence } from '../../daemon/cell/server-status.ts'
import { setResolveFleetPresence } from '../../platform/ports/fleet-presence.ts'

setResolveFleetPresence(resolveFleetPresence)

const dbUrl = getDatabaseUrl()

const MANAGED_NETWORK = '00000000-0000-4000-8000-0000000000ee'

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
  serverId: string
): Promise<void> {
  await attachDaemonStateToServer(db, serverId, {
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
    // `key.fingerprint` is globally unique now (schema-child-tables,
    // Road-to-0.1.x) — a fixed fingerprint would collide across the
    // multiple servers some fixtures attach in one test.
    fingerprint: `fp-test-${crypto.randomUUID()}`,
  })
  const now = new Date().toISOString()
  // Fleet status lives on dedicated `server` columns now — never on
  // `server.daemon` jsonb (see `mapServerDaemonStatusFromColumns`).
  await db
    .update(server)
    .set({
      isConnected: true,
      statusChangedAt: now,
      updatedAt: now,
    })
    .where(eq(server.id, serverId))
}

function createDispatchMockRegistry(
  serverId: string,
  options: {
    waitForRequestResult: PendingRequestRecord | null
  }
): DaemonCellRegistry & {
  enqueueCalled: boolean
  waitForRequestCalled: boolean
  capturedOutbound: unknown
  enqueueOpts: { ttlSeconds?: number } | undefined
} {
  const state = {
    enqueueCalled: false,
    waitForRequestCalled: false,
    capturedOutbound: null as unknown,
    enqueueOpts: undefined as { ttlSeconds?: number } | undefined,
  }

  const cell: DaemonCell = {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      }),
    detachDaemonSocket: () => Promise.resolve(),
    recordInbound: () => Promise.resolve(),
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
    enqueue: (outbound, opts) => {
      state.enqueueCalled = true
      state.capturedOutbound = outbound
      state.enqueueOpts = opts
      return Promise.resolve({
        serverId,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued' as const,
        createdAt: outbound.at,
        expiresAt: outbound.at,
      })
    },
    markSent: () => Promise.resolve(),
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => {
      state.waitForRequestCalled = true
      return Promise.resolve(options.waitForRequestResult)
    },
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
    releaseDeliveryLease: () => Promise.resolve(),
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => Promise.resolve(),
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
    get enqueueOpts() {
      return state.enqueueOpts
    },
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

async function withConsumerFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('command consumer tests')
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
  serverId: string
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
  await withConsumerFixtures(async ({ db, serverId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })

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
    await db
      .update(server)
      .set({
        options: { timezone: 'UTC' },
        updatedAt: now,
      })
      .where(eq(server.id, serverId))

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

test('processCommandEnvelope refuses a connected daemon below the supported floor, and passes one that reports no version', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    await projectServerDaemon(db, serverId, {
      kind: 'daemon-build',
      daemonBuild: { commit: 'abc1234', buildId: 'b-old', version: '0.0.9' },
    })
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
    assertEquals(updated?.errorCode, 'daemon_unsupported')
    assertEquals(
      updated?.error,
      'Daemon version 0.0.9 is below the supported minimum 0.1.0 — update the daemon'
    )
    // Never reached the cell: the update envelope is the only thing such a
    // daemon should get, and that is not a command.
    assertEquals(registry.enqueueCalled, false)

    // A build that reports no version (every build before 0.1.0) still gets
    // its commands — unknown is a flag, not a refusal.
    await projectServerDaemon(db, serverId, {
      kind: 'daemon-build',
      daemonBuild: { commit: 'abc1234', buildId: 'b-unversioned' },
    })
    const second = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    const registry2 = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })
    await processCommandEnvelope(db, registry2, buildEnvelope(second, serverId))
    assertEquals(registry2.enqueueCalled, true)
  })
})

test('processCommandEnvelope succeeds for online ping command', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
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
    // Success drops the dispatch payload immediately.
    assertEquals(await getCommandDispatchPayload(db, record.id), null)
  })
})

test('processCommandEnvelope dispatches the stored payload and retains it after failure', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'server.hostname.set',
      payload: { hostname: 'web-77' },
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
        error: 'hostnamectl failed',
      },
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    // The daemon envelope carries the `dispatch` payload, not a `command` column.
    const outbound = registry.capturedOutbound as Record<string, unknown>
    assertEquals(outbound.payload, { hostname: 'web-77' })

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
    assertEquals(updated?.error, 'hostnamectl failed')

    // Failure keeps the payload for ~24h instead of deleting it.
    assertEquals(await getCommandDispatchPayload(db, record.id), {
      hostname: 'web-77',
    })
    const [dispatchRow] = await db
      .select({ expiresAt: dispatch.expiresAt })
      .from(dispatch)
      .where(eq(dispatch.commandId, record.id))
      .limit(1)
    const retainedMs = Date.parse(dispatchRow!.expiresAt!)
    const expectedMs = Date.now() + COMMAND_DISPATCH_FAILURE_RETENTION_MS
    assertEquals(Math.abs(retainedMs - expectedMs) < 60_000, true)

    // Nothing expired yet, so the bounded sweep leaves it alone.
    assertEquals(await sweepExpiredCommandDispatch(db, { limit: 50 }), 0)
  })
})

test('processCommandEnvelope fails cleanly when the dispatch payload is gone', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    await deleteCommandDispatch(db, record.id)

    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    assertEquals(registry.enqueueCalled, false)
    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
    assertEquals(updated?.error, 'Command dispatch payload unavailable')
    assertEquals(updated?.errorCode, 'dispatch_payload_missing')
  })
})

test('processCommandEnvelope updates server metadata on hostname success', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
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
      .select({ options: server.options, timezone: server.timezone })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    const options = row?.options as { timezone?: string } | null
    assertEquals(options?.timezone, 'America/Chicago')
    assertEquals(row?.timezone, 'America/Chicago')
  })
})

test('processCommandEnvelope leaves server.options.timezone unchanged on timezone failure', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const now = new Date().toISOString()
    await db
      .update(server)
      .set({
        options: { timezone: 'UTC' },
        updatedAt: now,
      })
      .where(eq(server.id, serverId))

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
    await db
      .update(server)
      .set({
        options: { timezone: 'UTC' },
        updatedAt: now,
      })
      .where(eq(server.id, serverId))

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
  await withConsumerFixtures(async ({ db, serverId }) => {
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
    await processCommandEnvelope(db, failedRegistry, buildEnvelope(failedRecord, serverId))
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
    await processCommandEnvelope(db, timeoutRegistry, buildEnvelope(timeoutRecord, serverId))
    const timeoutUpdated = await getCommandRecord(db, timeoutRecord.id)
    assertEquals(timeoutUpdated?.status, 'timed_out')
  })
})

test('processCommandEnvelope leaves NTP columns unchanged on malformed ntp success', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const priorNtpServers = [{ host: 'pool.ntp.org' }]
    const priorStamp = '2026-01-01T00:00:00.000Z'
    const now = new Date().toISOString()
    await db
      .update(server)
      .set({
        timezone: 'UTC',
        isTimeSyncEnabled: true,
        ntpServers: priorNtpServers,
        ntpLastSyncedAt: priorStamp,
        updatedAt: now,
      })
      .where(eq(server.id, serverId))

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
      .select({
        timezone: server.timezone,
        isTimeSyncEnabled: server.isTimeSyncEnabled,
        ntpServers: server.ntpServers,
        ntpLastSyncedAt: server.ntpLastSyncedAt,
      })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals(row?.timezone, 'UTC')
    assertEquals(row?.isTimeSyncEnabled, true)
    assertEquals(row?.ntpServers, priorNtpServers)
    // postgres.js may return timestamptz as 'YYYY-MM-DD HH:mm:ss+00'
    const observedStamp = row?.ntpLastSyncedAt
    if (observedStamp == null) {
      throw new TypeError('expected ntpLastSyncedAt to remain set')
    }
    assertEquals(new Date(observedStamp).toISOString(), new Date(priorStamp).toISOString())
  })
})

const FABRIC_WG_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const SKIPPED_FABRIC_DESIRED_HASH = 'skipped-stamp-desired-hash'

test('processCommandEnvelope stamps appliedPayloadHash when fabric reconcile is skipped with a publicKey', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const fabricRow = await enableOrganizationFabric(db, organizationId)
    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'server.fabric.reconcile',
        payload: {
          enabled: true,
          fabricId: fabricRow.id,
          address: '10.250.0.11/32',
          prefix: '10.192.0.0/16',
          peers: [],
        },
        metadata: { desiredHash: SKIPPED_FABRIC_DESIRED_HASH },
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
            summary: 'TurboFabric reconciled',
            skipped: true,
            publicKey: FABRIC_WG_PUBKEY,
            peers: [{ publicKey: FABRIC_WG_PUBKEY }],
          },
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const updated = await getCommandRecord(db, record.id)
      assertEquals(updated?.status, 'succeeded')

      const relays = await listFabricRelays(db, fabricRow.id)
      const stamped = relays.find((row) => row.serverId === serverId)
      assertEquals(stamped?.publicKey, FABRIC_WG_PUBKEY)
      assertEquals(stamped?.metadata.appliedPayloadHash, SKIPPED_FABRIC_DESIRED_HASH)
    } finally {
      await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
    }
  })
})

test('processCommandEnvelope stamps appliedPayloadHash for a payload with no tunnel and no key', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const fabricRow = await enableOrganizationFabric(db, organizationId)
    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'server.fabric.reconcile',
        payload: {
          enabled: true,
          fabricId: fabricRow.id,
          tunnel: false,
          prefix: '10.192.0.0/16',
          peers: [],
          lanRoutes: [],
        },
        metadata: { desiredHash: 'tunnelless-desired-hash' },
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
          result: { summary: 'TurboFabric reconciled without a tunnel' },
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const relays = await listFabricRelays(db, fabricRow.id)
      const stamped = relays.find((row) => row.serverId === serverId)
      assertEquals(stamped?.publicKey, null)
      assertEquals(stamped?.metadata.appliedPayloadHash, 'tunnelless-desired-hash')
    } finally {
      await db.delete(fabric).where(eq(fabric.organizationId, organizationId))
    }
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
    rootLoginId: string
  }) => Promise<void>
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
        organizationId,
        name: 'Managed Destroy Test Project',
        kind: 'managed',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'production',
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
        options: { settings: {} },
      })
      .returning({ id: managed.id })
    const managedId = managedRow!.id
    const [rootLoginRow] = await db
      .insert(login)
      .values({
        recipe: 'app',
        managedId,
        role: 'root',
        username: 'postgres',
        appliedUsername: 'postgres',
      })
      .returning({ id: login.id })

    try {
      await fn({
        db,
        serverId,
        managedId,
        rootLoginId: rootLoginRow!.id,
      })
    } finally {
      await db.delete(login).where(eq(login.managedId, managedId))
      await db.delete(managed).where(eq(managed.id, managedId))
      await db.delete(environment).where(eq(environment.id, environmentRow!.id))
      await db.delete(project).where(eq(project.id, projectRow!.id))
      await db.delete(workspace).where(eq(workspace.id, workspaceRow!.id))
    }
  })
}

test('processCommandEnvelope releases an applying managed row when the daemon is offline', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db.update(managed).set({ status: 'applying' }).where(eq(managed.id, managedId))
    // The fixture attaches a connected daemon; take it offline before dispatch.
    await db.update(server).set({ isConnected: false }).where(eq(server.id, serverId))
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
    const registry = createDispatchMockRegistry(serverId, { waitForRequestResult: null })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

    const [row] = await db.select().from(managed).where(eq(managed.id, managedId))
    assertEquals(row?.status, 'failed')
    assertEquals(registry.enqueueCalled, false)
    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.error, 'Daemon not connected')
  })
})

test('processCommandEnvelope deletes the managed row and cascades logins when deleteAfterDestroy succeeds', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId, rootLoginId }) => {
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
    // marker removes the managed row, which cascades to its logins via
    // `login.managed_id ON DELETE CASCADE`.
    const [managedAfter] = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedAfter, undefined)

    const [principalAfter] = await db
      .select({ id: login.id })
      .from(login)
      .where(eq(login.id, rootLoginId))
      .limit(1)
    assertEquals(principalAfter, undefined)
  })
})

test('processCommandEnvelope leaves the managed row and logins in place without deleteAfterDestroy', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId, rootLoginId }) => {
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
      .select({ id: login.id })
      .from(login)
      .where(eq(login.id, rootLoginId))
      .limit(1)
    assertEquals(principalAfter?.id, rootLoginId)
  })
})

async function runDestroyReportingNoContainers(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const record = await createCommandRecord(db, {
    serverId,
    ...TEST_COMMAND_ACTOR,
    type: 'managed.destroy',
    payload,
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
  assertEquals((await getCommandRecord(db, record.id))?.status, 'succeeded')
}

async function seedRunningContainer(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
  managedId: string
): Promise<{ serviceId: string; environmentId: string }> {
  const [row] = await db
    .select({ environmentId: managed.environmentId })
    .from(managed)
    .where(eq(managed.id, managedId))
  const environmentId = row!.environmentId
  const [serviceRow] = await db
    .insert(service)
    .values({ environmentId, name: 'db', composeServiceName: 'db' })
    .returning({ id: service.id })
  await db.insert(container).values({
    serviceId: serviceRow!.id,
    serverId,
    containerId: 'new-database-cid',
    containerName: 'managed-db-1',
    status: 'running',
    composeServiceName: 'db',
    ordinal: 1,
  })
  return { serviceId: serviceRow!.id, environmentId }
}

test('a late destroy for a deleted database leaves the container rows of the one created in its place', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const { serviceId, environmentId } = await seedRunningContainer(db, serverId, managedId)
    try {
      // The old database (a different id) was force deleted; this destroy is
      // the retry that finally reached its host.
      await runDestroyReportingNoContainers(db, serverId, {
        managedId: '00000000-0000-4000-8000-0000000000aa',
        removeVolumes: true,
        environmentId,
      })
      const [kept] = await db
        .select({ status: container.status })
        .from(container)
        .where(eq(container.serviceId, serviceId))
      assertEquals(kept?.status, 'running')
    } finally {
      await db.delete(container).where(eq(container.serviceId, serviceId))
      await db.delete(service).where(eq(service.id, serviceId))
    }
  })
})

test('a destroy of the only database in the environment still clears its container rows', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const { serviceId, environmentId } = await seedRunningContainer(db, serverId, managedId)
    try {
      await runDestroyReportingNoContainers(db, serverId, {
        managedId,
        removeVolumes: true,
        environmentId,
      })
      const [row] = await db
        .select({ status: container.status })
        .from(container)
        .where(eq(container.serviceId, serviceId))
      assertEquals(row?.status !== 'running', true)
    } finally {
      await db.delete(container).where(eq(container.serviceId, serviceId))
      await db.delete(service).where(eq(service.id, serviceId))
    }
  })
})

test('processCommandEnvelope no-ops for terminal or expired commands', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const succeeded = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    await transitionCommand(db, succeeded.id, {
      status: 'succeeded',
      result: {},
    })

    const succeededRegistry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: null,
    })
    await processCommandEnvelope(db, succeededRegistry, buildEnvelope(succeeded, serverId))
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
    await processCommandEnvelope(db, expiredRegistry, buildEnvelope(expired, serverId))
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
        organizationId,
        name: 'Lifecycle Reconcile Project',
        kind: 'compose',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'production',
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
        organizationId,
        name: 'Lifecycle Skip Project',
        kind: 'compose',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'production',
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
        organizationId,
        name: 'System Reconcile Project',
        kind: 'compose',
        metadata: { component: 'hosting-ingress' },
        component: 'hosting-ingress',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'hosting-ingress',
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

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
        organizationId,
        name: 'System Skip Project',
        kind: 'compose',
        metadata: { component: 'hosting-ingress' },
        component: 'hosting-ingress',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'hosting-ingress',
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

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
        organizationId,
        name: 'System Empty Project',
        kind: 'compose',
        metadata: { component: 'hosting-ingress' },
        component: 'hosting-ingress',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'hosting-ingress',
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

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

test('processCommandEnvelope reconciles containers on managed.ingress.reconcile success', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({
        organizationId,
        name: 'Managed Ingress Workspace',
        kind: 'turbopanel',
      })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        organizationId,
        name: 'Managed Ingress Project',
        kind: 'compose',
        metadata: { component: 'managed-ingress' },
        component: 'managed-ingress',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'managed-ingress',
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'proxysql',
        composeServiceName: 'proxysql',
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
        composeServiceName: 'proxysql',
        ordinal: 1,
      })
      .returning({ id: container.id })
    const containerRowId = containerRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.ingress.reconcile',
        payload: {
          serverId,
          managedNetwork: MANAGED_NETWORK,
          clusters: [],
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
            summary: 'managed ingress reconciled',
            appliedUsers: [],
            appliedBackends: [],
            restarted: false,
            containers: [
              {
                serviceId,
                composeServiceName: 'proxysql',
                containerId: 'proxysql-cid-1',
                containerName,
                status: 'running',
                role: 'ingress',
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
          id: container.id,
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.id, containerRowId))
        .limit(1)
      assertEquals(row?.id, containerRowId)
      assertEquals(row?.containerId, 'proxysql-cid-1')
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

test('processCommandEnvelope clears pins when managed.ingress.reconcile reports empty containers', async () => {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)

    const [workspaceRow] = await db
      .insert(workspace)
      .values({
        organizationId,
        name: 'Managed Ingress Empty Workspace',
        kind: 'turbopanel',
      })
      .returning({ id: workspace.id })
    const [projectRow] = await db
      .insert(project)
      .values({
        workspaceId: workspaceRow!.id,
        organizationId,
        name: 'Managed Ingress Empty Project',
        kind: 'compose',
        metadata: { component: 'managed-ingress' },
        component: 'managed-ingress',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'managed-ingress',
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id
    const [serviceRow] = await db
      .insert(service)
      .values({
        environmentId,
        name: 'proxysql',
        composeServiceName: 'proxysql',
      })
      .returning({ id: service.id })
    const serviceId = serviceRow!.id
    const containerName = `${serviceId}-in`
    const [containerRow] = await db
      .insert(container)
      .values({
        serviceId,
        serverId,
        containerId: 'old-proxysql-cid',
        containerName,
        status: 'running',
        role: 'ingress',
        composeServiceName: 'proxysql',
        ordinal: 1,
      })
      .returning({ id: container.id })
    const containerRowId = containerRow!.id

    try {
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.ingress.reconcile',
        payload: {
          serverId,
          managedNetwork: MANAGED_NETWORK,
          clusters: [],
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
            summary: 'managed ingress torn down',
            appliedUsers: [],
            appliedBackends: [],
            restarted: false,
            containers: [],
          },
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

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
        organizationId,
        name: 'TurboPanel',
        kind: 'compose',
        metadata: { component: 'turbopanel' },
        component: 'turbopanel',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'production',
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
        role: 'turbopanel',
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
              role: 'turbopanel',
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
                role: 'turbopanel',
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
      assertEquals(row?.role, 'turbopanel')
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
        organizationId,
        name: 'TurboPanel',
        kind: 'compose',
        metadata: { component: 'turbopanel' },
        component: 'turbopanel',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'production',
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
        role: 'turbopanel',
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
              role: 'turbopanel',
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

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
        organizationId,
        name: 'TurboPanel',
        kind: 'compose',
        metadata: { component: 'turbopanel' },
        component: 'turbopanel',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'production',
      })
      .returning({ id: environment.id })
    const environmentId = environmentRow!.id

    const composeNames = ['database', 'queue'] as const
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
          role: 'turbopanel',
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
            role: 'turbopanel' as const,
            desired: 'present' as const,
          })),
        },
      })

      // Daemon reports only database running — queue must remain
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
                role: 'turbopanel',
              },
            ],
          },
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const rows = await db
        .select({
          id: container.id,
          serviceId: container.serviceId,
          containerId: container.containerId,
          status: container.status,
        })
        .from(container)
        .where(eq(container.serverId, serverId))

      assertEquals(rows.length, 2)
      const byService = new Map(rows.map((row) => [row.serviceId, row]))
      assertEquals(byService.get(serviceIds[0]!)?.id, containerRowIds[0])
      assertEquals(byService.get(serviceIds[0]!)?.containerId, 'db-only-cid')
      assertEquals(byService.get(serviceIds[0]!)?.status, 'running')
      assertEquals(byService.get(serviceIds[1]!)?.id, containerRowIds[1])
      assertEquals(byService.get(serviceIds[1]!)?.containerId, null)
      assertEquals(byService.get(serviceIds[1]!)?.status, 'exited')
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

test('processCommandEnvelope merges NTP facts into server NTP columns on success', async () => {
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
      .select({
        isTimeSyncEnabled: server.isTimeSyncEnabled,
        ntpServers: server.ntpServers,
        ntpLastSyncedAt: server.ntpLastSyncedAt,
      })
      .from(server)
      .where(eq(server.id, serverId))
      .limit(1)
    assertEquals(row?.isTimeSyncEnabled, true)
    assertEquals(row?.ntpServers, [
      { host: 'time.cloudflare.com' },
      { host: 'pool.ntp.org', fallback: true },
    ])
    assertEquals(typeof row?.ntpLastSyncedAt, 'string')
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
  }) => Promise<void>
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
        organizationId,
        name: 'Deploy Consumer Project',
        kind: 'compose',
      })
      .returning({ id: project.id })
    const [environmentRow] = await db
      .insert(environment)
      .values({
        projectId: projectRow!.id,
        serverId,
        name: 'production',
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
  managedNetwork: MANAGED_NETWORK,
  image: 'docker.io/library/postgres:18-alpine',
  containerPort: 5432,
  composeYaml: 'services:\n  postgres:\n    image: postgres:18-alpine\n',
  configFiles: [
    {
      path: 'postgresql.conf',
      contents: "listen_addresses = '*'\n",
      mode: '0640',
    },
    {
      path: 'pg_hba.conf',
      contents: '# TurboPanel managed PostgreSQL — platform pg_hba\nlocal all all peer\n',
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
      password: 'tpdaemon.v1.server.key.payload',
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
  }) => Promise<void>
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
  await withDeployFixtures(
    async ({ db, organizationId, serverId, environmentId, projectId, webServiceId }) => {
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
          composeFiles: [
            {
              filename: 'compose.yaml',
              role: 'runtime',
              source: 'inline',
              content: 'services:\n  web:\n    image: nginx\n',
            },
          ],
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

      const [vol] = await db
        .insert(storage)
        .values({ organizationId, environmentId, kind: 'volume', name: 'data' })
        .returning({ id: storage.id })
      const [copy] = await db
        .insert(storageCopy)
        .values({
          storageId: vol!.id,
          serverId,
          provider: 'docker',
          role: 'primary',
          state: 'pending',
        })
        .returning({ id: storageCopy.id })
      // Copies the deploy never created must stay pending: scratch, non-docker, and a
      // service-scoped volume of a service that has no container on this server.
      const [otherService] = await db
        .insert(service)
        .values({ environmentId, name: 'elsewhere', composeServiceName: 'elsewhere' })
        .returning({ id: service.id })
      const extraStorage = await db
        .insert(storage)
        .values([
          { organizationId, environmentId, kind: 'volume', name: 'scratchy' },
          { organizationId, environmentId, kind: 'volume', name: 'remote' },
          {
            organizationId,
            kind: 'volume',
            name: 'scoped',
            serviceId: otherService!.id,
          },
          {
            organizationId,
            kind: 'volume',
            name: 'scoped-here',
            serviceId: webServiceId,
          },
        ])
        .returning({ id: storage.id })
      const extraCopies = await db
        .insert(storageCopy)
        .values([
          {
            storageId: extraStorage[0]!.id,
            serverId,
            provider: 'docker',
            role: 'scratch',
            state: 'pending',
          },
          {
            storageId: extraStorage[1]!.id,
            serverId,
            provider: 's3',
            role: 'primary',
            state: 'pending',
          },
          {
            storageId: extraStorage[2]!.id,
            serverId,
            provider: 'docker',
            role: 'primary',
            state: 'pending',
          },
          {
            storageId: extraStorage[3]!.id,
            serverId,
            provider: 'docker',
            role: 'primary',
            state: 'pending',
          },
        ])
        .returning({ id: storageCopy.id })

      const cleanup = async () => {
        for (const extra of extraCopies)
          await db.delete(storageCopy).where(eq(storageCopy.id, extra.id))
        for (const extra of extraStorage) await db.delete(storage).where(eq(storage.id, extra.id))
        await db.delete(service).where(eq(service.id, otherService!.id))
      }
      try {
        await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))
        const labels = ['scratch', 's3', 'service-scoped elsewhere', 'service-scoped here']
        for (const [index, extra] of extraCopies.entries()) {
          const [extraRow] = await db
            .select({ state: storageCopy.state })
            .from(storageCopy)
            .where(eq(storageCopy.id, extra.id))
          // The last copy belongs to a service this deploy ran on this server.
          const want = index === extraCopies.length - 1 ? 'ready' : 'pending'
          assertEquals(extraRow?.state, want, `${labels[index]} copy must be ${want}`)
        }
      } finally {
        await cleanup()
      }

      const [row] = await db
        .select({ containerId: container.containerId, status: container.status })
        .from(container)
        .where(eq(container.serviceId, webServiceId))
        .limit(1)
      assertEquals(row?.containerId, 'deploy-cid')
      assertEquals(row?.status, 'running')
      const [copyRow] = await db
        .select({ state: storageCopy.state })
        .from(storageCopy)
        .where(eq(storageCopy.id, copy!.id))
      assertEquals(copyRow?.state, 'ready')
      await db.delete(storageCopy).where(eq(storageCopy.id, copy!.id))
      await db.delete(storage).where(eq(storage.id, vol!.id))
    }
  )
})

test('processCommandEnvelope marks the folders a deploy planned as present, and only those', async () => {
  await withDeployFixtures(
    async ({ db, organizationId, serverId, environmentId, projectId, webServiceId }) => {
      await attachConnectedDaemonStatus(db, serverId)
      const username = `fp_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
      const [owner] = await db
        .insert(principal)
        .values({
          organizationId,
          username,
          appliedUsername: username,
        })
        .returning({ id: principal.id })
      const base = {
        serverId,
        principalId: owner!.id,
        environmentId,
        scope: 'production',
        kind: 'service',
        state: 'planned',
      }
      const [planned, untouched] = await db
        .insert(folder)
        .values([
          { ...base, slug: 'web', serviceId: webServiceId },
          { ...base, slug: 'other' },
        ])
        .returning({ id: folder.id })
      try {
        const record = await createCommandRecord(db, {
          serverId,
          ...TEST_COMMAND_ACTOR,
          type: 'environment.deploy',
          metadata: { folderIds: [planned!.id] },
          payload: {
            environmentId,
            projectId,
            organizationId,
            projectName: 'tp-deploy-test',
            composeFiles: [
              {
                filename: 'compose.yaml',
                role: 'runtime',
                source: 'inline',
                content: 'services:\n  web:\n    image: nginx\n',
              },
            ],
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
            result: { projectName: 'tp-deploy-test', summary: 'deployed' },
          },
        })
        await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))
        const states = await db
          .select({ id: folder.id, state: folder.state })
          .from(folder)
          .where(eq(folder.serverId, serverId))
        assertEquals(Object.fromEntries(states.map((row) => [row.id, row.state])), {
          [planned!.id]: 'present',
          [untouched!.id]: 'planned',
        })
      } finally {
        await db.delete(folder).where(eq(folder.serverId, serverId))
        await db.delete(principal).where(eq(principal.id, owner!.id))
      }
    }
  )
})

test('processCommandEnvelope records a rolled back and a needs attention sequential deploy', async () => {
  await withDeployFixtures(async ({ db, organizationId, serverId, environmentId, projectId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const cases = [
      ['rolled_back: web failed its healthcheck', 'rolled_back'],
      ['needs_attention: a migration already ran', 'needs_attention'],
      ['Docker Compose deployment failed', null],
    ] as const
    for (const [daemonError, expected] of cases) {
      await db.delete(deployment).where(eq(deployment.serverId, serverId))
      await db.insert(deployment).values({
        environmentId,
        serverId,
        desiredGeneration: 2,
        appliedGeneration: 1,
        status: 'applying',
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
          composeFiles: [
            {
              filename: 'compose.yaml',
              role: 'runtime',
              source: 'inline',
              content: 'services:\n  web:\n    image: nginx\n',
            },
          ],
          hostings: [],
          deployStrategy: 'sequential',
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
          error: daemonError,
        },
      })
      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))
      const updated = await getCommandRecord(db, record.id)
      assertEquals(updated?.status, 'failed')
      assertEquals(updated?.error, daemonError)
      assertEquals(updated?.errorCode ?? null, expected === null ? null : `deploy_${expected}`)
      const [row] = await db
        .select({
          status: deployment.status,
          outcome: deployment.outcome,
          metadata: deployment.metadata,
          applied: deployment.appliedGeneration,
        })
        .from(deployment)
        .where(eq(deployment.serverId, serverId))
      assertEquals(row?.status, 'failed')
      // The column's check only allows applied / failed / timed_out.
      assertEquals(row?.outcome, 'failed')
      assertEquals((row?.metadata as { strategyOutcome: unknown }).strategyOutcome, expected)
      assertEquals(row?.applied, 1)
    }
  })
})

test('processCommandEnvelope records a deploy the host stopped on request as cancelled, keeping the old generation', async () => {
  await withDeployFixtures(async ({ db, organizationId, serverId, environmentId, projectId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    await db.delete(deployment).where(eq(deployment.serverId, serverId))
    await db.insert(deployment).values({
      environmentId,
      serverId,
      desiredGeneration: 2,
      appliedGeneration: 1,
      status: 'applying',
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
        composeFiles: [
          {
            filename: 'compose.yaml',
            role: 'runtime',
            source: 'inline',
            content: 'services:\n  web:\n    image: nginx\n',
          },
        ],
        hostings: [],
        generation: 2,
      },
    })
    const daemonError = 'cancelled: stopped while building; the previous version is still running'
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'failed',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        error: daemonError,
      },
    })
    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))
    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'cancelled')
    assertEquals(updated?.error, daemonError)
    assertEquals(updated?.errorCode, 'deploy_cancelled')
    const [row] = await db
      .select({
        status: deployment.status,
        outcome: deployment.outcome,
        metadata: deployment.metadata,
        applied: deployment.appliedGeneration,
      })
      .from(deployment)
      .where(eq(deployment.serverId, serverId))
    assertEquals(row?.status, 'failed')
    assertEquals(row?.outcome, 'failed')
    assertEquals((row?.metadata as { cancelled: unknown }).cancelled, true)
    // The previous generation is still the applied one.
    assertEquals(row?.applied, 1)
  })
})

/** Two servers of one deploy, generation 5: `serverId` is batch 0 (applying), a second is batch 1 (held). */
async function holdSecondServerOfRollout(
  db: Parameters<Parameters<typeof withDeployFixtures>[0]>[0]['db'],
  ctx: { organizationId: string; serverId: string; environmentId: string; projectId: string }
): Promise<{ firstCommandId: string; heldServerId: string; heldCommandId: string }> {
  const now = new Date().toISOString()
  const [held] = await db
    .insert(server)
    .values({
      organizationId: ctx.organizationId,
      name: 'rollout-held',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const payload = {
    environmentId: ctx.environmentId,
    projectId: ctx.projectId,
    organizationId: ctx.organizationId,
    projectName: 'tp-deploy-test',
    composeFiles: [
      {
        filename: 'compose.yaml',
        role: 'runtime',
        source: 'inline',
        content: 'services:\n  web:\n    image: nginx\n',
      },
    ],
    hostings: [],
    generation: 5,
  }
  const first = await createCommandRecord(db, {
    serverId: ctx.serverId,
    ...TEST_COMMAND_ACTOR,
    type: 'environment.deploy',
    payload,
  })
  const second = await createCommandRecord(db, {
    serverId: held!.id,
    ...TEST_COMMAND_ACTOR,
    type: 'environment.deploy',
    payload: { ...payload, serverId: held!.id },
  })
  await db.insert(deployment).values([
    {
      environmentId: ctx.environmentId,
      serverId: ctx.serverId,
      desiredGeneration: 5,
      status: 'applying',
      lastCommandId: first.id,
      options: { rollout: { batch: 0, batches: 2 } },
    },
    {
      environmentId: ctx.environmentId,
      serverId: held!.id,
      desiredGeneration: 5,
      status: 'pending',
      lastCommandId: second.id,
      options: { rollout: { batch: 1, batches: 2 } },
    },
  ])
  return { firstCommandId: first.id, heldServerId: held!.id, heldCommandId: second.id }
}

async function removeHeldServer(
  db: Parameters<Parameters<typeof withDeployFixtures>[0]>[0]['db'],
  heldServerId: string
): Promise<void> {
  await db.delete(deployment).where(eq(deployment.serverId, heldServerId))
  await db.delete(command).where(eq(command.serverId, heldServerId))
  await db.delete(server).where(eq(server.id, heldServerId))
}

async function finishFirstOfRollout(
  db: Parameters<Parameters<typeof withDeployFixtures>[0]>[0]['db'],
  ids: { serverId: string; firstCommandId: string },
  outcome: { status: 'done'; result: unknown } | { status: 'failed'; error: string },
  sent: CommandEnvelope[]
): Promise<void> {
  const record = await getCommandRecord(db, ids.firstCommandId)
  const registry = createDispatchMockRegistry(ids.serverId, {
    waitForRequestResult: {
      serverId: ids.serverId,
      requestId: ids.firstCommandId,
      requestKind: 'command-dispatch',
      createdAt: record!.createdAt,
      expiresAt: record!.createdAt,
      finishedAt: new Date().toISOString(),
      ...outcome,
    },
  })
  const queue = {
    enqueue: (envelope: CommandEnvelope) => Promise.resolve(void sent.push(envelope)),
  }
  await processCommandEnvelope(db, registry, buildEnvelope(record!, ids.serverId), {
    firewallApplyGate: DENY_FIREWALL_APPLY,
    commandQueue: queue,
  })
}

test('processCommandEnvelope delivers the next rolling batch when a deploy succeeds', async () => {
  await withDeployFixtures(async ({ db, organizationId, serverId, environmentId, projectId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const held = await holdSecondServerOfRollout(db, {
      organizationId,
      serverId,
      environmentId,
      projectId,
    })
    const sent: CommandEnvelope[] = []
    try {
      await finishFirstOfRollout(
        db,
        { serverId, firstCommandId: held.firstCommandId },
        { status: 'done', result: { projectName: 'tp-deploy-test', summary: 'deployed' } },
        sent
      )
      assertEquals(
        sent.map((envelope) => envelope.commandId),
        [held.heldCommandId]
      )
      assertEquals(sent[0]?.serverId, held.heldServerId)
      const [row] = await db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.serverId, held.heldServerId))
      assertEquals(row?.status, 'applying')
    } finally {
      await removeHeldServer(db, held.heldServerId)
    }
  })
})

test('processCommandEnvelope stops a rolling deploy when a server fails and flags the rest', async () => {
  await withDeployFixtures(async ({ db, organizationId, serverId, environmentId, projectId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const held = await holdSecondServerOfRollout(db, {
      organizationId,
      serverId,
      environmentId,
      projectId,
    })
    const sent: CommandEnvelope[] = []
    try {
      await finishFirstOfRollout(
        db,
        { serverId, firstCommandId: held.firstCommandId },
        { status: 'failed', error: 'rolled_back: web failed its healthcheck' },
        sent
      )
      assertEquals(sent.length, 0)
      const [row] = await db
        .select({ status: deployment.status, metadata: deployment.metadata })
        .from(deployment)
        .where(eq(deployment.serverId, held.heldServerId))
      assertEquals(row?.status, 'failed')
      assertEquals((row?.metadata as { rollout: unknown }).rollout, 'not_started')
      assertEquals((await getCommandRecord(db, held.heldCommandId))?.status, 'cancelled')
      // The server that failed keeps its own rolled_back outcome.
      assertEquals(
        (await getCommandRecord(db, held.firstCommandId))?.errorCode,
        'deploy_rolled_back'
      )
    } finally {
      await removeHeldServer(db, held.heldServerId)
    }
  })
})

test('processCommandEnvelope: a deploy command that expired before dispatch stops the rollout', async () => {
  await withDeployFixtures(async ({ db, organizationId, serverId, environmentId, projectId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const held = await holdSecondServerOfRollout(db, {
      organizationId,
      serverId,
      environmentId,
      projectId,
    })
    try {
      await db
        .update(command)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(command.id, held.firstCommandId))
      await db
        .update(command)
        .set({ context: { environmentId, serverId, generation: 5 } })
        .where(eq(command.id, held.firstCommandId))
      const sent: CommandEnvelope[] = []
      const record = await getCommandRecord(db, held.firstCommandId)
      await processCommandEnvelope(
        db,
        createDispatchMockRegistry(serverId, { waitForRequestResult: null }),
        buildEnvelope(record!, serverId),
        {
          firewallApplyGate: DENY_FIREWALL_APPLY,
          commandQueue: { enqueue: (envelope) => Promise.resolve(void sent.push(envelope)) },
        }
      )
      assertEquals((await getCommandRecord(db, held.firstCommandId))?.status, 'timed_out')
      const [first] = await db
        .select({ status: deployment.status, outcome: deployment.outcome })
        .from(deployment)
        .where(eq(deployment.serverId, serverId))
      assertEquals(first?.status, 'failed')
      assertEquals(first?.outcome, 'timed_out')
      const [heldRow] = await db
        .select({ status: deployment.status })
        .from(deployment)
        .where(eq(deployment.serverId, held.heldServerId))
      assertEquals(heldRow?.status, 'failed')
      assertEquals((await getCommandRecord(db, held.heldCommandId))?.status, 'cancelled')
      assertEquals(sent.length, 0)
    } finally {
      await removeHeldServer(db, held.heldServerId)
    }
  })
})

type RolloutDb = Parameters<Parameters<typeof withDeployFixtures>[0]>[0]['db']

/**
 * Three servers at parallelism 1, generation 5: the fixture server applied
 * batch 0, a second server is applying batch 1 (no daemon attached, so it is
 * offline), a third waits in batch 2.
 */
async function rolloutStuckOnOfflineServer(
  db: RolloutDb,
  ctx: { organizationId: string; serverId: string; environmentId: string; projectId: string }
): Promise<{ serverIds: string[]; commandIds: string[] }> {
  const now = new Date().toISOString()
  const extra = await db
    .insert(server)
    .values(
      ['rollout-offline', 'rollout-waiting'].map((name) => ({
        organizationId: ctx.organizationId,
        name,
        createdAt: now,
        updatedAt: now,
      }))
    )
    .returning({ id: server.id })
  const serverIds = [ctx.serverId, ...extra.map((row) => row.id)]
  const payload = {
    environmentId: ctx.environmentId,
    projectId: ctx.projectId,
    organizationId: ctx.organizationId,
    projectName: 'tp-deploy-test',
    composeFiles: [
      {
        filename: 'compose.yaml',
        role: 'runtime',
        source: 'inline',
        content: 'services:\n  web:\n    image: nginx\n',
      },
    ],
    hostings: [],
    generation: 5,
  }
  const records = await Promise.all(
    serverIds.map((id) =>
      createCommandRecord(db, {
        serverId: id,
        ...TEST_COMMAND_ACTOR,
        type: 'environment.deploy',
        payload,
        context: { environmentId: ctx.environmentId, serverId: id, generation: 5 },
      })
    )
  )
  const commandIds = records.map((record) => record.id)
  const statuses = ['applied', 'applying', 'pending'] as const
  await db.insert(deployment).values(
    serverIds.map((id, index) => ({
      environmentId: ctx.environmentId,
      serverId: id,
      desiredGeneration: 5,
      status: statuses[index]!,
      lastCommandId: commandIds[index]!,
      options: { rollout: { batch: index, batches: 3 } },
    }))
  )
  return { serverIds, commandIds }
}

async function removeRolloutServers(db: RolloutDb, serverIds: readonly string[]): Promise<void> {
  const extra = serverIds.slice(1)
  await db.delete(deployment).where(inArray(deployment.serverId, [...serverIds]))
  await db.delete(command).where(inArray(command.serverId, [...serverIds]))
  await db.delete(server).where(inArray(server.id, extra))
}

/** Batch 1 failed, batch 2 flagged "not started" with its command cancelled: the rollout is over. */
async function assertRolloutHaltedAtSecondServer(
  db: RolloutDb,
  rollout: { serverIds: string[]; commandIds: string[] }
): Promise<void> {
  const rows = await db
    .select({
      serverId: deployment.serverId,
      status: deployment.status,
      metadata: deployment.metadata,
    })
    .from(deployment)
    .where(inArray(deployment.serverId, rollout.serverIds))
  const byServer = new Map(rows.map((row) => [row.serverId, row]))
  assertEquals(byServer.get(rollout.serverIds[0]!)?.status, 'applied')
  assertEquals(byServer.get(rollout.serverIds[1]!)?.status, 'failed')
  const waiting = byServer.get(rollout.serverIds[2]!)
  assertEquals(waiting?.status, 'failed')
  assertEquals((waiting?.metadata as { rollout: unknown }).rollout, 'not_started')
  assertEquals((await getCommandRecord(db, rollout.commandIds[2]!))?.status, 'cancelled')
  // Nothing is left applying or pending, so nothing waits on this rollout.
  assertEquals(
    rows.some((row) => row.status === 'applying' || row.status === 'pending'),
    false
  )
}

test('processCommandEnvelope: a rollout server whose daemon is offline fails and stops the rollout', async () => {
  await withDeployFixtures(async ({ db, organizationId, serverId, environmentId, projectId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const rollout = await rolloutStuckOnOfflineServer(db, {
      organizationId,
      serverId,
      environmentId,
      projectId,
    })
    try {
      const offlineServerId = rollout.serverIds[1]!
      const record = await getCommandRecord(db, rollout.commandIds[1]!)
      const registry = createDispatchMockRegistry(offlineServerId, { waitForRequestResult: null })
      await processCommandEnvelope(db, registry, buildEnvelope(record!, offlineServerId))
      assertEquals(registry.enqueueCalled, false)
      const failed = await getCommandRecord(db, rollout.commandIds[1]!)
      assertEquals(failed?.status, 'failed')
      assertEquals(failed?.error, 'Daemon not connected')
      await assertRolloutHaltedAtSecondServer(db, rollout)
    } finally {
      await removeRolloutServers(db, rollout.serverIds)
    }
  })
})

test('processCommandEnvelope: a rollout server whose dispatch payload is gone fails and stops the rollout', async () => {
  await withDeployFixtures(async ({ db, organizationId, serverId, environmentId, projectId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const rollout = await rolloutStuckOnOfflineServer(db, {
      organizationId,
      serverId,
      environmentId,
      projectId,
    })
    try {
      const targetServerId = rollout.serverIds[1]!
      await deleteCommandDispatch(db, rollout.commandIds[1]!)
      const record = await getCommandRecord(db, rollout.commandIds[1]!)
      const registry = createDispatchMockRegistry(targetServerId, { waitForRequestResult: null })
      await processCommandEnvelope(db, registry, buildEnvelope(record!, targetServerId))
      assertEquals(
        (await getCommandRecord(db, rollout.commandIds[1]!))?.errorCode,
        'dispatch_payload_missing'
      )
      await assertRolloutHaltedAtSecondServer(db, rollout)
    } finally {
      await removeRolloutServers(db, rollout.serverIds)
    }
  })
})

/** Run one succeeded command of `type` through the consumer with the host's `result`. */
async function runSucceededCommand(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
  type:
    | 'environment.stop'
    | 'environment.deploy'
    | 'server.folders.remove'
    | 'server.principals.reconcile',
  payload: unknown,
  result: unknown
): Promise<void> {
  const record = await createCommandRecord(db, { serverId, ...TEST_COMMAND_ACTOR, type, payload })
  const registry = createDispatchMockRegistry(serverId, {
    waitForRequestResult: {
      serverId,
      requestId: record.id,
      requestKind: 'command-dispatch',
      status: 'done',
      createdAt: record.createdAt,
      expiresAt: record.createdAt,
      finishedAt: new Date().toISOString(),
      result,
    },
  })
  await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))
}

/** Two site owners and folder rows for them, removed after the callback. */
async function withOwnerFolders(
  ctx: {
    db: ReturnType<typeof createDenoDb>
    organizationId: string
    serverId: string
    environmentId: string
  },
  rows: Array<{
    owner: 'one' | 'two'
    kind: 'service' | 'volume'
    slug: string
    state: string
    scope?: string
  }>,
  fn: (owners: {
    one: { id: string; login: string }
    two: { id: string; login: string }
  }) => Promise<void>
): Promise<void> {
  const make = async () => {
    const login = `fo_${crypto.randomUUID().slice(0, 8).replaceAll('-', '')}`
    const [row] = await ctx.db
      .insert(principal)
      .values({ organizationId: ctx.organizationId, username: login, appliedUsername: login })
      .returning({ id: principal.id })
    return { id: row!.id, login }
  }
  const one = await make()
  const two = await make()
  try {
    if (rows.length > 0) {
      await ctx.db.insert(folder).values(
        rows.map((row) => ({
          serverId: ctx.serverId,
          principalId: (row.owner === 'one' ? one : two).id,
          environmentId: row.scope === 'common' ? null : ctx.environmentId,
          scope: row.scope ?? 'production',
          kind: row.kind,
          slug: row.slug,
          state: row.state,
        }))
      )
    }
    await fn({ one, two })
  } finally {
    await ctx.db.delete(folder).where(eq(folder.serverId, ctx.serverId))
    await ctx.db.delete(principalPlacement).where(eq(principalPlacement.serverId, ctx.serverId))
    await ctx.db.delete(principal).where(inArray(principal.id, [one.id, two.id]))
  }
}

async function folderStates(
  db: ReturnType<typeof createDenoDb>,
  serverId: string
): Promise<Record<string, string>> {
  const rows = await db
    .select({ kind: folder.kind, slug: folder.slug, state: folder.state })
    .from(folder)
    .where(eq(folder.serverId, serverId))
  return Object.fromEntries(rows.map((row) => [`${row.kind}:${row.slug}`, row.state]))
}

test('processCommandEnvelope clears the removing folder rows an environment.stop reports gone, and keeps the others', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [
        { owner: 'one', kind: 'service', slug: 'gone', state: 'removing' },
        { owner: 'one', kind: 'service', slug: 'stuck', state: 'removing' },
        // The same names under another owner, and a folder in use, are not the report's to touch.
        { owner: 'two', kind: 'service', slug: 'gone', state: 'removing' },
        { owner: 'one', kind: 'service', slug: 'live', state: 'present' },
      ],
      async ({ one }) => {
        await runSucceededCommand(
          ctx.db,
          ctx.serverId,
          'environment.stop',
          {
            environmentId: ctx.environmentId,
            projectId: ctx.projectId,
            projectName: 'tp-stop-test',
          },
          {
            projectName: 'tp-stop-test',
            summary: 'stopped',
            containers: [],
            folders: [
              {
                owner: one.login,
                scope: 'production',
                kind: 'service',
                slug: 'gone',
                removed: true,
              },
              {
                owner: one.login,
                scope: 'production',
                kind: 'service',
                slug: 'stuck',
                removed: false,
                reason: 'The folder was not removed: device busy',
              },
              {
                owner: one.login,
                scope: 'production',
                kind: 'service',
                slug: 'live',
                removed: true,
              },
            ],
          }
        )
        const rows = await ctx.db
          .select({ slug: folder.slug, state: folder.state, principalId: folder.principalId })
          .from(folder)
          .where(eq(folder.serverId, ctx.serverId))
        assertEquals(
          rows
            .map((row) => `${row.principalId === one.id ? 'one' : 'two'}:${row.slug}:${row.state}`)
            .sort(),
          ['one:live:present', 'one:stuck:removing', 'two:gone:removing']
        )
        // The environment's last folder rows are the ones left; the locks follow the rows.
        assertEquals((await listEnvironmentFolders(ctx.db, ctx.environmentId)).total, 3)
      }
    )
  })
})

test('processCommandEnvelope clears a removed volume and lifts the environment lock once its last folder is gone', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [{ owner: 'one', kind: 'volume', slug: 'uploads', state: 'removing' }],
      async ({ one }) => {
        assertEquals((await listEnvironmentFolders(ctx.db, ctx.environmentId)).total, 1)
        await runSucceededCommand(
          ctx.db,
          ctx.serverId,
          'server.folders.remove',
          {
            folders: [
              {
                kind: 'volume',
                folder: { owner: one.login, scope: 'production', slug: 'uploads' },
              },
            ],
          },
          {
            summary: 'Removed 1 of 1 folder(s)',
            folders: [
              {
                owner: one.login,
                scope: 'production',
                kind: 'volume',
                slug: 'uploads',
                removed: true,
              },
            ],
          }
        )
        assertEquals(await folderStates(ctx.db, ctx.serverId), {})
        assertEquals(await environmentHasFolders(ctx.db, ctx.environmentId), false)
      }
    )
  })
})

test('processCommandEnvelope leaves a volume row removing when the host says the folder stayed', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [{ owner: 'one', kind: 'volume', slug: 'uploads', state: 'removing' }],
      async ({ one }) => {
        await runSucceededCommand(
          ctx.db,
          ctx.serverId,
          'server.folders.remove',
          {
            folders: [
              {
                kind: 'volume',
                folder: { owner: one.login, scope: 'production', slug: 'uploads' },
              },
            ],
          },
          {
            summary: 'Removed 0 of 1 folder(s)',
            folders: [
              {
                owner: one.login,
                scope: 'production',
                kind: 'volume',
                slug: 'uploads',
                removed: false,
                reason: 'The folder was not removed: device busy',
              },
            ],
          }
        )
        assertEquals(await folderStates(ctx.db, ctx.serverId), { 'volume:uploads': 'removing' })
        assertEquals(await environmentHasFolders(ctx.db, ctx.environmentId), true)
      }
    )
  })
})

test('processCommandEnvelope marks the folders a deploy kept as orphans', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [
        { owner: 'one', kind: 'service', slug: 'old', state: 'present' },
        { owner: 'one', kind: 'service', slug: 'deleted', state: 'removing' },
        { owner: 'one', kind: 'service', slug: 'web', state: 'present' },
      ],
      async ({ one }) => {
        // The report only moves rows older than the command; keep the rows clearly before it.
        await new Promise((resolve) => setTimeout(resolve, 5))
        await runSucceededCommand(
          ctx.db,
          ctx.serverId,
          'environment.deploy',
          {
            environmentId: ctx.environmentId,
            projectId: ctx.projectId,
            organizationId: ctx.organizationId,
            projectName: 'tp-deploy-test',
            composeFiles: [
              {
                filename: 'compose.yaml',
                role: 'runtime',
                source: 'inline',
                content: 'services:\n  web:\n    image: nginx\n',
              },
            ],
            hostings: [],
          },
          {
            projectName: 'tp-deploy-test',
            summary: 'deployed',
            keptFolders: [
              { owner: one.login, scope: 'production', kind: 'service', slug: 'old' },
              // An explicit delete finishes its own way; a kept report does not undo it.
              { owner: one.login, scope: 'production', kind: 'service', slug: 'deleted' },
            ],
          }
        )
        // This command carries no generation, so it cannot be placed among the deploys and
        // decides nothing about `web`, which the deploy did not plan.
        assertEquals(await folderStates(ctx.db, ctx.serverId), {
          'service:old': 'orphan',
          'service:deleted': 'removing',
          'service:web': 'present',
        })
        // An orphan still locks the environment until someone removes it.
        assertEquals(await environmentHasFolders(ctx.db, ctx.environmentId), true)
      }
    )
  })
})

test('processCommandEnvelope marks a present service folder the newest deploy did not plan as an orphan', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [
        { owner: 'one', kind: 'service', slug: 'gone', state: 'present' },
        { owner: 'one', kind: 'service', slug: 'gone-too', state: 'planned' },
      ],
      async () => {
        await ctx.db.delete(deployment).where(eq(deployment.serverId, ctx.serverId))
        const record = await createCommandRecord(ctx.db, {
          serverId: ctx.serverId,
          ...TEST_COMMAND_ACTOR,
          type: 'environment.deploy',
          payload: {
            environmentId: ctx.environmentId,
            projectId: ctx.projectId,
            organizationId: ctx.organizationId,
            projectName: 'tp-deploy-test',
            composeFiles: [
              {
                filename: 'compose.yaml',
                role: 'runtime',
                source: 'inline',
                content: 'services:\n  web:\n    image: nginx\n',
              },
            ],
            hostings: [],
            generation: 2,
          },
        })
        await ctx.db.insert(deployment).values({
          environmentId: ctx.environmentId,
          serverId: ctx.serverId,
          desiredGeneration: 2,
          appliedGeneration: 1,
          status: 'applying',
          lastCommandId: record.id,
        })
        const registry = createDispatchMockRegistry(ctx.serverId, {
          waitForRequestResult: {
            serverId: ctx.serverId,
            requestId: record.id,
            requestKind: 'command-dispatch',
            status: 'done',
            createdAt: record.createdAt,
            expiresAt: record.createdAt,
            finishedAt: new Date().toISOString(),
            result: { projectName: 'tp-deploy-test', summary: 'deployed' },
          },
        })
        await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId))
        // A planned row is another deploy's business; a present one the deploy did not plan is kept as an orphan.
        assertEquals(await folderStates(ctx.db, ctx.serverId), {
          'service:gone': 'orphan',
          'service:gone-too': 'planned',
        })
      }
    )
  })
})

test('a deploy whose planned folders cannot be read concludes nothing about the rest', async () => {
  const failing = {
    select() {
      throw new Error('database unavailable')
    },
  } as unknown as Db
  const planned = await markPlannedFoldersPresentSafely(failing, {
    id: crypto.randomUUID(),
  } as unknown as DispatchableCommandRecord)
  assertEquals(planned, null)
})

test('processCommandEnvelope compares a reconcile listing with the folder rows and records the host home', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [
        { owner: 'one', kind: 'service', slug: 'here', state: 'present' },
        { owner: 'one', kind: 'volume', slug: 'lost', state: 'present' },
        { owner: 'one', kind: 'volume', slug: 'back', state: 'missing' },
        { owner: 'one', kind: 'volume', slug: 'leaving', state: 'removing' },
        { owner: 'one', kind: 'service', slug: 'planned', state: 'planned' },
        { owner: 'one', kind: 'service', slug: 'kept', state: 'orphan' },
      ],
      async ({ one }) => {
        // The owner belongs to the project, and its environment is named like the scope,
        // so a folder found with no row can be tied to the environment it sits under.
        await ctx.db
          .update(principal)
          .set({ projectId: ctx.projectId })
          .where(eq(principal.id, one.id))
        await ctx.db
          .update(environment)
          .set({ name: 'production' })
          .where(eq(environment.id, ctx.environmentId))
        await ctx.db.insert(principalPlacement).values({
          principalId: one.id,
          serverId: ctx.serverId,
          state: 'present',
          home: '/srv/users/old',
          source: 'manual',
        })
        const listed = (kind: 'service' | 'volume', slug: string, scope = 'production') => ({
          owner: one.login,
          scope,
          kind,
          slug,
          present: true,
        })
        await runSucceededCommand(
          ctx.db,
          ctx.serverId,
          'server.principals.reconcile',
          { principals: [] },
          {
            principalsApplied: 1,
            keysChanged: [],
            keysRemoved: [],
            sshdReloaded: false,
            sftpChroot: false,
            principals: [
              { principalId: one.id, uid: 15001, gid: 15001, home: `/srv/users/${one.login}` },
            ],
            folders: [
              listed('service', 'here'),
              listed('volume', 'back'),
              // A folder no row names: recorded, not touched.
              listed('volume', 'stranger'),
            ],
            warnings: [],
          }
        )
        assertEquals(await folderStates(ctx.db, ctx.serverId), {
          'service:here': 'present',
          'volume:lost': 'missing',
          'volume:back': 'present',
          // Not on the host yet: planned rows wait for their deploy. A removing row and an
          // orphan the host no longer has are gone.
          'service:planned': 'planned',
          'volume:stranger': 'orphan',
        })
        const [placement] = await ctx.db
          .select({ home: principalPlacement.home })
          .from(principalPlacement)
          .where(eq(principalPlacement.serverId, ctx.serverId))
        assertEquals(placement?.home, `/srv/users/${one.login}`)
        // A missing folder no longer blocks; the orphan does, and says why.
        const blocking = await listEnvironmentFolders(ctx.db, ctx.environmentId)
        assertEquals(blocking.folders.map((row) => `${row.slug}:${row.state}`).sort(), [
          'back:present',
          'here:present',
          'planned:planned',
          'stranger:orphan',
        ])
        assertEquals(
          blocking.folders.find((row) => row.slug === 'stranger')?.reason,
          'no service or volume owns this folder on server Consumer Test Server'
        )
      }
    )
  })
})

test('processCommandEnvelope concludes nothing about folders from a reconcile that sent no listing', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [
        { owner: 'one', kind: 'volume', slug: 'a', state: 'present' },
        { owner: 'one', kind: 'volume', slug: 'b', state: 'removing' },
      ],
      async () => {
        await runSucceededCommand(
          ctx.db,
          ctx.serverId,
          'server.principals.reconcile',
          { principals: [] },
          {
            principalsApplied: 0,
            keysChanged: [],
            keysRemoved: [],
            sshdReloaded: false,
            sftpChroot: false,
            warnings: ['the folders on this server could not be listed this time'],
          }
        )
        assertEquals(await folderStates(ctx.db, ctx.serverId), {
          'volume:a': 'present',
          'volume:b': 'removing',
        })
      }
    )
  })
})

test('processCommandEnvelope marks a retiring account absent once the host reports it retired', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [{ owner: 'one', kind: 'volume', slug: 'a', state: 'present' }],
      async ({ one }) => {
        await ctx.db.insert(principalPlacement).values({
          principalId: one.id,
          serverId: ctx.serverId,
          state: 'retiring',
          home: `/srv/users/${one.login}`,
          source: 'manual',
        })
        await runSucceededCommand(
          ctx.db,
          ctx.serverId,
          'server.principals.reconcile',
          { principals: [], retirePrincipals: [{ username: one.login }] },
          {
            principalsApplied: 0,
            keysChanged: [],
            keysRemoved: [],
            sshdReloaded: false,
            sftpChroot: false,
            principalsRetired: [one.login],
            warnings: [],
          }
        )
        const [placement] = await ctx.db
          .select({ state: principalPlacement.state })
          .from(principalPlacement)
          .where(eq(principalPlacement.principalId, one.id))
        assertEquals(placement?.state, 'absent')
      }
    )
  })
})

test('processCommandEnvelope clears pins on environment.stop success', async () => {
  await withDeployFixtures(async ({ db, serverId, environmentId, projectId, webServiceId }) => {
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
  await withManagedApplyFixtures(async ({ db, serverId, managedId, environmentId, serviceId }) => {
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
    assertEquals((managedRow?.metadata as { host?: string; port?: number }).host, '203.0.113.10')
    assertEquals((managedRow?.metadata as { host?: string; port?: number }).port, 5432)

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
  await withManagedApplyFixtures(async ({ db, serverId, managedId, environmentId, serviceId }) => {
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, replicaServerId))

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
      assertEquals((managedRow?.metadata as { host?: string; port?: number }).host, '203.0.113.1')
      assertEquals((managedRow?.metadata as { host?: string; port?: number }).port, 5432)

      const [containerRow] = await db
        .select({
          containerId: container.containerId,
          status: container.status,
        })
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
        options: { settings: {} },
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

    const rows = await db
      .select({ id: backup.backupId, managedId: backup.managedId, serverId: backup.serverId })
      .from(backup)
      .where(eq(backup.managedId, managedId))
    assertEquals(rows.length, 1)
    assertEquals(rows[0]?.id, 'bk_1700000000000')
    assertEquals(rows[0]?.serverId, serverId)
  })
})

test('processCommandEnvelope sets managed.status ready on managed.restore success', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db.update(managed).set({ status: 'applying' }).where(eq(managed.id, managedId))

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
    await db.update(managed).set({ status: 'applying' }).where(eq(managed.id, managedId))

    const [managedRow] = await db
      .select({ environmentId: managed.environmentId })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)

    const memberId = MANAGED_APPLY_PAYLOAD.memberId
    await db.insert(replica).values({
      id: memberId,
      managedId,
      serverId,
      role: 'primary',
      isReadEligible: true,
      ordinal: 1,
      status: 'provisioning',
    })

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
      .select({ status: managed.status, metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(afterManaged?.status, 'failed')
    assertEquals(parseManagedResidual(afterManaged?.metadata).error, 'Command timed out')

    // Member must not stay stuck on provisioning after the apply command fails.
    const [afterMember] = await db
      .select({ status: replica.status })
      .from(replica)
      .where(eq(replica.id, memberId))
      .limit(1)
    assertEquals(afterMember?.status, 'failed')
  })
})

test('processCommandEnvelope leaves managed.status unchanged when managed.backup fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db.update(managed).set({ status: 'ready' }).where(eq(managed.id, managedId))

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
    true
  )
  assertEquals(
    isTransientError(Object.assign(new Error('ignored'), { name: 'NetworkError' })),
    true
  )
  assertEquals(
    isTransientError(Object.assign(new Error('ignored'), { name: 'ConnectionError' })),
    true
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
    assertEquals((updated?.result as Record<string, unknown>).cellDispatchedAt, sentAt)
  })
})

test('processCommandEnvelope skips hostname metadata when result omits observedHostname', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const now = new Date().toISOString()
    await db
      .update(server)
      .set({
        hostname: 'before-hostname',
        updatedAt: now,
      })
      .where(eq(server.id, serverId))

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
    await db
      .update(server)
      .set({
        options: { timezone: 'UTC' },
        updatedAt: now,
      })
      .where(eq(server.id, serverId))

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
    assertEquals(updated?.error, 'Unexpected pending request status: acked')
  })
})

test('processCommandEnvelope marks managed failed when lifecycle pending expires', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db.update(managed).set({ status: 'applying' }).where(eq(managed.id, managedId))

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
      .select({ status: managed.status, metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'failed')
    assertEquals(parseManagedResidual(managedRow?.metadata).error, 'Command timed out')
  })
})

test('processCommandEnvelope marks managed failed when lifecycle command fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db.update(managed).set({ status: 'ready' }).where(eq(managed.id, managedId))

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
      .select({ status: managed.status, metadata: managed.metadata })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedRow?.status, 'failed')
    assertEquals(parseManagedResidual(managedRow?.metadata).error, 'compose stop failed')
  })
})

type LifecycleRig = {
  db: ReturnType<typeof createDenoDb>
  serverId: string
  managedId: string
  memberId: string
  engineServiceId: string
  ingressServiceId: string
}

/**
 * A one-member cluster with its engine container, and the server's shared
 * managed-ingress container on a system service of its own, all running.
 */
async function withLifecycleRig(
  memberStatus: string,
  fn: (rig: LifecycleRig) => Promise<void>
): Promise<void> {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const [managedRow] = await db
      .select({ environmentId: managed.environmentId })
      .from(managed)
      .where(eq(managed.id, managedId))
    const [environmentRow] = await db
      .select({ projectId: environment.projectId })
      .from(environment)
      .where(eq(environment.id, managedRow!.environmentId))
    const memberId = crypto.randomUUID()
    await db.insert(replica).values({
      id: memberId,
      managedId,
      serverId,
      role: 'primary',
      isReadEligible: true,
      ordinal: 1,
      status: memberStatus,
    })
    const [systemEnvironment] = await db
      .insert(environment)
      .values({ projectId: environmentRow!.projectId, serverId, name: 'managed-ingress' })
      .returning({ id: environment.id })
    const [engineService] = await db
      .insert(service)
      .values({ environmentId: managedRow!.environmentId, name: 'db', composeServiceName: 'db' })
      .returning({ id: service.id })
    const [ingressService] = await db
      .insert(service)
      .values({
        environmentId: systemEnvironment!.id,
        name: 'managed-ingress',
        composeServiceName: 'managed-ingress',
      })
      .returning({ id: service.id })
    const running = { serverId, status: 'running', ordinal: 1 }
    await db.insert(container).values([
      {
        ...running,
        serviceId: engineService!.id,
        containerId: 'db-cid',
        containerName: 'db-1',
        role: 'service',
        composeServiceName: 'db',
      },
      {
        ...running,
        serviceId: ingressService!.id,
        containerId: 'ingress-cid',
        containerName: 'managed-ingress-1',
        role: 'ingress',
        composeServiceName: 'managed-ingress',
      },
    ])
    const serviceIds = [engineService!.id, ingressService!.id]
    try {
      await fn({
        db,
        serverId,
        managedId,
        memberId,
        engineServiceId: engineService!.id,
        ingressServiceId: ingressService!.id,
      })
    } finally {
      await db.delete(container).where(inArray(container.serviceId, serviceIds))
      await db.delete(service).where(inArray(service.id, serviceIds))
      await db.delete(environment).where(eq(environment.id, systemEnvironment!.id))
      await db.delete(replica).where(eq(replica.id, memberId))
    }
  })
}

/** Run one stop on the rig's member; the server answers with `result`. */
async function runMemberStop(
  rig: LifecycleRig,
  result: Record<string, unknown>,
  db: LifecycleRig['db'] = rig.db
): Promise<void> {
  const record = await createCommandRecord(rig.db, {
    serverId: rig.serverId,
    ...TEST_COMMAND_ACTOR,
    type: 'managed.lifecycle',
    payload: { managedId: rig.managedId, action: 'stop', memberId: rig.memberId },
  })
  const registry = createDispatchMockRegistry(rig.serverId, {
    waitForRequestResult: {
      serverId: rig.serverId,
      requestId: record.id,
      requestKind: 'command-dispatch',
      status: 'done',
      createdAt: record.createdAt,
      expiresAt: record.createdAt,
      finishedAt: new Date().toISOString(),
      result,
    },
  })
  await processCommandEnvelope(db, registry, buildEnvelope(record, rig.serverId))
}

async function rigState(rig: LifecycleRig): Promise<{ member?: string; containers: string[] }> {
  const [memberRow] = await rig.db
    .select({ status: replica.status })
    .from(replica)
    .where(eq(replica.id, rig.memberId))
  const rows = await rig.db
    .select({ role: container.role, status: container.status })
    .from(container)
    .where(inArray(container.serviceId, [rig.engineServiceId, rig.ingressServiceId]))
  return {
    member: memberRow?.status,
    containers: rows.map((row) => `${row.role}:${row.status}`).sort(),
  }
}

test('a status-only stop result marks the member stopped and its engine container exited', async () => {
  await withLifecycleRig('ready', async (rig) => {
    // The daemon answers every stop with a status only: it cannot read health from a stopped container.
    await runMemberStop(rig, { status: 'stopped' })
    assertEquals(await rigState(rig), {
      member: 'stopped',
      containers: ['ingress:running', 'service:exited'],
    })
  })
})

test('a status-only stop never clears needs_resync on a demoted member', async () => {
  await withLifecycleRig('needs_resync', async (rig) => {
    await runMemberStop(rig, { status: 'stopped' })
    assertEquals((await rigState(rig)).member, 'needs_resync')
  })
})

test('a failed stop marks the member failed and leaves the containers alone', async () => {
  await withLifecycleRig('ready', async (rig) => {
    await runMemberStop(rig, { status: 'failed' })
    assertEquals(await rigState(rig), {
      member: 'failed',
      containers: ['ingress:running', 'service:running'],
    })
  })
})

test('a stop result with a status the member row cannot take writes nothing to it', async () => {
  await withLifecycleRig('ready', async (rig) => {
    await runMemberStop(rig, { status: 'half-stopped' })
    assertEquals(await rigState(rig), {
      member: 'ready',
      containers: ['ingress:running', 'service:running'],
    })
  })
})

/** The rig's db, except that every write to a member row fails. */
function failingMemberWrites(db: LifecycleRig['db']): LifecycleRig['db'] {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return (table: unknown) => {
          if (table === replica) throw new Error('member write refused')
          return target.update(table as typeof replica)
        }
      }
      const value: unknown = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('a failed member write from a status-only stop still marks the containers exited', async () => {
  await withLifecycleRig('ready', async (rig) => {
    await runMemberStop(rig, { status: 'stopped' }, failingMemberWrites(rig.db))
    assertEquals(await rigState(rig), {
      member: 'ready',
      containers: ['ingress:running', 'service:exited'],
    })
  })
})

test('processCommandEnvelope ignores non-projectable managed lifecycle status', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    await db.update(managed).set({ status: 'ready' }).where(eq(managed.id, managedId))

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
        options: { settings: {} },
      })
      .where(eq(managed.id, managedId))
    await db.insert(backup).values({
      backupId: 'bk_1700000000000',
      managedId,
      createdAt: '2020-01-01T00:00:00.000Z',
      sizeBytes: 1024,
      checksum: 'a'.repeat(64),
      path: '/var/lib/turbopanel/backups/bk_1700000000000.dump',
    })

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

    const rows = await db
      .select({ id: backup.id })
      .from(backup)
      .where(eq(backup.managedId, managedId))
    assertEquals(rows, [])
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
    await db.update(managed).set({ status: 'applying' }).where(eq(managed.id, managedId))

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

type PromoteFixture = {
  standbyServerId: string
  primaryMemberId: string
  replicaMemberId: string
}

/** A primary on `serverId` and a ready replica on a second connected server. */
async function insertPromotePair(
  db: Db,
  params: { serverId: string; managedId: string }
): Promise<PromoteFixture> {
  const { serverId, managedId } = params
  await attachConnectedDaemonStatus(db, serverId)
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
    .insert(replica)
    // A cluster's first member has no replica class: it never was a replica.
    .values({
      managedId,
      serverId,
      role: 'primary',
      ordinal: 1,
      status: 'ready',
      replicaClass: null,
    })
    .returning({ id: replica.id })
  const [replicaMember] = await db
    .insert(replica)
    .values({ managedId, serverId: standbyServerId, role: 'replica', ordinal: 2, status: 'ready' })
    .returning({ id: replica.id })
  return {
    standbyServerId,
    primaryMemberId: primaryMember!.id,
    replicaMemberId: replicaMember!.id,
  }
}

async function cleanUpPromotePair(
  db: Db,
  params: { serverId: string; managedId: string; standbyServerId: string }
): Promise<void> {
  await db.delete(replica).where(eq(replica.managedId, params.managedId))
  // Promote may have flipped managed.serverId to the standby host; point
  // it back at the original server before dropping the standby row so
  // the FK doesn't block deletion.
  await db
    .update(managed)
    .set({ serverId: params.serverId })
    .where(eq(managed.id, params.managedId))
  await db.delete(command).where(eq(command.serverId, params.standbyServerId))
  await db.delete(server).where(eq(server.id, params.standbyServerId))
}

function promoteRegistry(
  record: { id: string; createdAt: string },
  standbyServerId: string,
  result: Record<string, unknown>
) {
  return createDispatchMockRegistry(standbyServerId, {
    waitForRequestResult: {
      serverId: standbyServerId,
      requestId: record.id,
      requestKind: 'command-dispatch',
      status: 'done',
      createdAt: record.createdAt,
      expiresAt: record.createdAt,
      finishedAt: new Date().toISOString(),
      result,
    },
  })
}

test('processCommandEnvelope demotes old primary before promote so uniq_node_primary holds', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const pair = await insertPromotePair(db, { serverId, managedId })
    const { standbyServerId, primaryMemberId, replicaMemberId } = pair

    try {
      const record = await createCommandRecord(db, {
        serverId: standbyServerId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.promote',
        payload: {
          managedId,
          memberId: replicaMemberId,
          demoteMemberId: primaryMemberId,
        },
      })

      const registry = promoteRegistry(record, standbyServerId, {
        promotedMemberId: replicaMemberId,
        demotedMemberId: primaryMemberId,
        status: 'ready',
        summary: 'promoted',
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, standbyServerId))

      const members = await db
        .select({
          id: replica.id,
          role: replica.role,
          status: replica.status,
          replicaClass: replica.replicaClass,
        })
        .from(replica)
        .where(eq(replica.managedId, managedId))

      const primary = members.find((m) => m.id === primaryMemberId)
      const replicaRow = members.find((m) => m.id === replicaMemberId)
      assertEquals(primary?.role, 'replica')
      assertEquals(primary?.status, 'needs_resync')
      // The demoted primary stays a failover candidate once it is resynced.
      assertEquals(primary?.replicaClass, 'failover')
      assertEquals(replicaRow?.role, 'primary')
      assertEquals(replicaRow?.status, 'ready')

      const [managedRow] = await db
        .select({ serverId: managed.serverId, status: managed.status })
        .from(managed)
        .where(eq(managed.id, managedId))
        .limit(1)
      assertEquals(managedRow?.serverId, standbyServerId)
      assertEquals(managedRow?.status, 'ready')
      // The primary moved, so the epoch went up by one.
      assertEquals(await loadPrimaryEpoch(db, managedId), 1)
    } finally {
      await cleanUpPromotePair(db, { serverId, managedId, standbyServerId })
    }
  })
})

test('a failover recover result moves the primary role and the epoch goes up by one', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const pair = await insertPromotePair(db, { serverId, managedId })
    const { standbyServerId, primaryMemberId, replicaMemberId } = pair
    try {
      const record = await createCommandRecord(db, {
        serverId: standbyServerId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.ha.failover',
        payload: {
          managedId,
          sourceMemberId: primaryMemberId,
          targetMemberId: replicaMemberId,
          phase: 'recover',
          engine: 'postgres',
        },
      })
      assertEquals(await loadPrimaryEpoch(db, managedId), 0)
      await processCommandEnvelope(
        db,
        promoteRegistry(record, standbyServerId, { summary: 'recovered', phase: 'recover' }),
        buildEnvelope(record, standbyServerId)
      )
      const [promoted] = await db
        .select({ role: replica.role })
        .from(replica)
        .where(eq(replica.id, replicaMemberId))
      assertEquals(promoted?.role, 'primary')
      assertEquals(await loadPrimaryEpoch(db, managedId), 1)
    } finally {
      await cleanUpPromotePair(db, { serverId, managedId, standbyServerId })
    }
  })
})

test('a lifecycle result without a member object speaks for the member it was sent to', () => {
  const stopped = { status: 'stopped' } as ManagedLifecycleCommandResult
  assertEquals(lifecycleFallbackMemberStatus({ memberId: 'replica-1' }, stopped), {
    memberId: 'replica-1',
    status: 'stopped',
  })
  // A result that names its member is projected as such, and a cluster-wide command names none.
  const named = {
    status: 'stopped',
    member: { memberId: 'primary-1', role: 'primary', status: 'stopped' },
  } as ManagedLifecycleCommandResult
  assertEquals(lifecycleFallbackMemberStatus({ memberId: 'replica-1' }, named), undefined)
  assertEquals(lifecycleFallbackMemberStatus({}, stopped), undefined)
  // A status the member row cannot take never reaches it.
  const odd = { status: 'half-stopped' } as ManagedLifecycleCommandResult
  assertEquals(lifecycleFallbackMemberStatus({ memberId: 'replica-1' }, odd), undefined)
})

test('a fence stop result that answers another switchover stores no final position', () => {
  const payload = parseManagedLifecyclePayload({
    managedId: 'managed-1',
    action: 'stop',
    engine: 'postgres',
    switchoverRecoveryId: '11111111-1111-4111-8111-111111111111',
    primaryEpoch: 0,
  })
  const result = {
    status: 'stopped',
    oldPrimaryFinalLsn: '0/7258050',
    oldPrimaryFinalTimeline: 1,
  } as ManagedLifecycleCommandResult
  assertEquals(oldPrimaryFinalFromStop(payload, '11111111-1111-4111-8111-111111111111', result), {
    oldPrimaryFinal: { lsn: '0/7258050', timeline: 1 },
  })
  assertEquals(oldPrimaryFinalFromStop(payload, '22222222-2222-4222-8222-222222222222', result), {})
})

test('a switchover promote result stores the new primary replay position on the recovery row and moves the epoch', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const pair = await insertPromotePair(db, { serverId, managedId })
    const { standbyServerId, primaryMemberId, replicaMemberId } = pair
    try {
      const created = await insertRecovery(db, {
        managedId,
        kind: 'switchover',
        sourcePrimaryMemberId: primaryMemberId,
        targetMemberId: replicaMemberId,
        state: 'promoting',
        metadata: {
          fenced: true,
          oldPrimaryFinalLsn: '0/7258050',
          oldPrimaryFinalTimeline: 1,
          primaryEpochAtStart: 0,
        },
      })
      const record = await createCommandRecord(db, {
        serverId: standbyServerId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.promote',
        payload: {
          managedId,
          memberId: replicaMemberId,
          demoteMemberId: primaryMemberId,
          engine: 'postgres',
        },
        metadata: { recoveryId: created.id },
      })
      const registry = promoteRegistry(record, standbyServerId, {
        promotedMemberId: replicaMemberId,
        demotedMemberId: primaryMemberId,
        status: 'ready',
        newPrimaryReplayLsn: '0/7258050',
        newPrimaryTimeline: 2,
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, standbyServerId))

      const stored = await findRecoveryById(db, created.id)
      assertEquals(stored?.metadata.newPrimaryReplayLsn, '0/7258050')
      assertEquals(stored?.metadata.newPrimaryTimeline, 2)
      assertEquals(evaluateFinalPosition(stored!.metadata).caughtUp, true)
      assertEquals(await loadPrimaryEpoch(db, managedId), 1)
    } finally {
      await db.delete(recoveryTable).where(eq(recoveryTable.managedId, managedId))
      await cleanUpPromotePair(db, { serverId, managedId, standbyServerId })
    }
  })
})

function createRecordingCommandQueue() {
  const envelopes: CommandEnvelope[] = []
  return {
    envelopes,
    enqueue: (envelope: CommandEnvelope) => {
      envelopes.push(envelope)
      return Promise.resolve()
    },
  }
}

test('processCommandEnvelope enqueues pendingStandbyApplies only after primary succeeds', async () => {
  await withManagedApplyFixtures(async ({ db, serverId, managedId, environmentId, serviceId }) => {
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

    try {
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
        firewallApplyGate: DENY_FIREWALL_APPLY,
        commandQueue: queue,
      })

      assertEquals(queue.envelopes.length, 1)
      assertEquals(queue.envelopes[0]?.type, 'managed.apply')
      assertEquals(queue.envelopes[0]?.serverId, standbyServerId)
    } finally {
      await db.delete(command).where(eq(command.serverId, standbyServerId))
      await db.delete(server).where(eq(server.id, standbyServerId))
    }
  })
})

test('processCommandEnvelope does not enqueue standbys when primary apply fails', async () => {
  await withManagedApplyFixtures(async ({ db, serverId, managedId, environmentId }) => {
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

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
      commandQueue: queue,
    })

    assertEquals(queue.envelopes.length, 0)
    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'failed')
  })
})

test('processCommandEnvelope enqueues the deferred primary destroy only after every replica succeeds', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    // Two gated replica destroys on one host. The primary destroy exists only
    // as metadata until both replicas succeed — the delete route never waited
    // for them.
    const gateId = crypto.randomUUID()
    const primaryPayload = {
      managedId,
      removeVolumes: true,
      memberId: '00000000-0000-4000-8000-0000000000c0',
      deleteAfterDestroy: true,
    }
    const gate = {
      gateId,
      memberIds: ['00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2'],
      followups: [
        {
          serverId,
          memberId: primaryPayload.memberId,
          payload: primaryPayload,
        },
      ],
    }

    const replicaRecords = []
    for (const memberId of gate.memberIds) {
      replicaRecords.push(
        await createCommandRecord(db, {
          serverId,
          ...TEST_COMMAND_ACTOR,
          type: 'managed.destroy',
          payload: { managedId, removeVolumes: true, memberId },
          metadata: { managedDestroyGate: gate },
        })
      )
    }

    const succeed = (record: CommandRecord) =>
      createDispatchMockRegistry(serverId, {
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

    const queue = createRecordingCommandQueue()

    // First replica succeeds — the gate is not satisfied yet.
    await processCommandEnvelope(
      db,
      succeed(replicaRecords[0]!),
      buildEnvelope(replicaRecords[0]!, serverId),
      { firewallApplyGate: DENY_FIREWALL_APPLY, commandQueue: queue }
    )
    assertEquals(
      queue.envelopes.filter((envelope) => envelope.type === 'managed.destroy').length,
      0
    )
    const [managedMidway] = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedMidway?.id, managedId)

    // Second replica succeeds — now the primary destroy is enqueued, exactly once.
    await processCommandEnvelope(
      db,
      succeed(replicaRecords[1]!),
      buildEnvelope(replicaRecords[1]!, serverId),
      { firewallApplyGate: DENY_FIREWALL_APPLY, commandQueue: queue }
    )
    const primaryEnvelopes = queue.envelopes.filter(
      (envelope) => envelope.type === 'managed.destroy'
    )
    assertEquals(primaryEnvelopes.length, 1)
    assertEquals(primaryEnvelopes[0]?.serverId, serverId)

    const followupPayload = (await getCommandDispatchPayload(
      db,
      primaryEnvelopes[0]!.commandId
    )) as { memberId?: string; deleteAfterDestroy?: boolean } | null
    assertEquals(followupPayload?.memberId, primaryPayload.memberId)
    assertEquals(followupPayload?.deleteAfterDestroy, true)

    // Re-delivering a replica must not enqueue a second primary destroy: the
    // gate claim is taken once on a deterministic anchor row.
    await processCommandEnvelope(
      db,
      succeed(replicaRecords[1]!),
      buildEnvelope(replicaRecords[1]!, serverId),
      { firewallApplyGate: DENY_FIREWALL_APPLY, commandQueue: queue }
    )
    assertEquals(
      queue.envelopes.filter((envelope) => envelope.type === 'managed.destroy').length,
      1
    )
  })
})

test('processCommandEnvelope leaves the primary intact when a gated replica destroy fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId, rootLoginId }) => {
    const gateId = crypto.randomUUID()
    const gate = {
      gateId,
      memberIds: ['00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d2'],
      followups: [
        {
          serverId,
          memberId: '00000000-0000-4000-8000-0000000000d0',
          payload: {
            managedId,
            removeVolumes: true,
            memberId: '00000000-0000-4000-8000-0000000000d0',
            deleteAfterDestroy: true,
          },
        },
      ],
    }

    const okRecord = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.destroy',
      payload: {
        managedId,
        removeVolumes: true,
        memberId: gate.memberIds[0],
      },
      metadata: { managedDestroyGate: gate },
    })
    const failingRecord = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.destroy',
      payload: {
        managedId,
        removeVolumes: true,
        memberId: gate.memberIds[1],
      },
      metadata: { managedDestroyGate: gate },
    })

    const queue = createRecordingCommandQueue()

    await processCommandEnvelope(
      db,
      createDispatchMockRegistry(serverId, {
        waitForRequestResult: {
          serverId,
          requestId: okRecord.id,
          requestKind: 'command-dispatch',
          status: 'done',
          createdAt: okRecord.createdAt,
          expiresAt: okRecord.createdAt,
          finishedAt: new Date().toISOString(),
          result: { status: 'stopped', containers: [] },
        },
      }),
      buildEnvelope(okRecord, serverId),
      { firewallApplyGate: DENY_FIREWALL_APPLY, commandQueue: queue }
    )

    await processCommandEnvelope(
      db,
      createDispatchMockRegistry(serverId, {
        waitForRequestResult: {
          serverId,
          requestId: failingRecord.id,
          requestKind: 'command-dispatch',
          status: 'failed',
          createdAt: failingRecord.createdAt,
          expiresAt: failingRecord.createdAt,
          finishedAt: new Date().toISOString(),
          error: 'destroy boom',
        },
      }),
      buildEnvelope(failingRecord, serverId),
      { firewallApplyGate: DENY_FIREWALL_APPLY, commandQueue: queue }
    )

    // A failed replica never opens the gate: no primary command, and the
    // managed row (with its logins) survives for a retry or force-delete.
    assertEquals(
      queue.envelopes.filter((envelope) => envelope.type === 'managed.destroy').length,
      0
    )
    const [managedAfter] = await db
      .select({ id: managed.id })
      .from(managed)
      .where(eq(managed.id, managedId))
      .limit(1)
    assertEquals(managedAfter?.id, managedId)
    const [principalAfter] = await db
      .select({ id: login.id })
      .from(login)
      .where(eq(login.id, rootLoginId))
      .limit(1)
    assertEquals(principalAfter?.id, rootLoginId)
  })
})

test('processCommandEnvelope ignores a malformed destroy gate instead of enqueuing a half-formed destroy', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'managed.destroy',
      payload: {
        managedId,
        removeVolumes: true,
        memberId: '00000000-0000-4000-8000-0000000000e1',
      },
      // No memberIds — the consumer must not guess what the gate meant.
      metadata: { managedDestroyGate: { gateId: 'g', followups: [] } },
    })
    const queue = createRecordingCommandQueue()

    await processCommandEnvelope(
      db,
      createDispatchMockRegistry(serverId, {
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
      }),
      buildEnvelope(record, serverId),
      { firewallApplyGate: DENY_FIREWALL_APPLY, commandQueue: queue }
    )

    assertEquals(queue.envelopes.length, 0)
    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'succeeded')
  })
})

async function runSwitchoverStop(
  f: { db: Db; serverId: string; managedId: string },
  stopResult: Record<string, unknown>
) {
  const { db, serverId, managedId } = f
  const [primaryMember] = await db
    .insert(replica)
    .values({ managedId, serverId, role: 'primary', ordinal: 1, status: 'ready' })
    .returning({ id: replica.id })
  const created = await insertRecovery(db, {
    managedId,
    kind: 'switchover',
    sourcePrimaryMemberId: primaryMember!.id,
    targetMemberId: null,
    state: 'fencing',
    metadata: { fenceCommandIds: [], drainApplied: true, primaryEpochAtStart: 0 },
  })
  const record = await createCommandRecord(db, {
    serverId,
    ...TEST_COMMAND_ACTOR,
    type: 'managed.lifecycle',
    payload: {
      managedId,
      action: 'stop',
      engine: 'postgres',
      memberId: primaryMember!.id,
      switchoverRecoveryId: created.id,
      primaryEpoch: 0,
    },
    metadata: { recoveryId: created.id, fencePhase: 'stop' },
  })
  await db
    .update(recoveryTable)
    .set({ metadata: { fenceCommandIds: [record.id], drainApplied: true, primaryEpochAtStart: 0 } })
    .where(eq(recoveryTable.id, created.id))
  await processCommandEnvelope(
    db,
    createDispatchMockRegistry(serverId, {
      waitForRequestResult: {
        serverId,
        requestId: record.id,
        requestKind: 'command-dispatch',
        status: 'done',
        createdAt: record.createdAt,
        expiresAt: record.createdAt,
        finishedAt: new Date().toISOString(),
        result: stopResult,
      },
    }),
    buildEnvelope(record, serverId),
    { firewallApplyGate: DENY_FIREWALL_APPLY, commandQueue: createRecordingCommandQueue() }
  )
  return (await findRecoveryById(db, created.id))!.metadata
}

test('a host that refuses a stale re-seed leaves the cluster ready and the former primary needs_resync', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const pair = await insertPromotePair(db, { serverId, managedId })
    const { standbyServerId, primaryMemberId, replicaMemberId } = pair
    try {
      // After the switchover: the second member is the primary, the first the
      // former primary waiting for its re-seed.
      await db
        .update(replica)
        .set({ role: 'replica', status: 'needs_resync' })
        .where(eq(replica.id, primaryMemberId))
      await db
        .update(replica)
        .set({ role: 'primary', status: 'ready' })
        .where(eq(replica.id, replicaMemberId))
      await db.update(managed).set({ status: 'applying' }).where(eq(managed.id, managedId))
      const created = await insertRecovery(db, {
        managedId,
        kind: 'switchover',
        sourcePrimaryMemberId: primaryMemberId,
        targetMemberId: replicaMemberId,
        state: 'completed',
        metadata: { fenced: true, reseedState: 'queued', reseedNote: 'queued' },
      })
      const record = await createCommandRecord(db, {
        serverId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.apply',
        payload: { managedId, memberId: primaryMemberId },
        context: { managedId, memberId: primaryMemberId },
        metadata: {
          [RESEED_GUARD_METADATA_KEY]: {
            recoveryId: created.id,
            managedId,
            sourceMemberId: primaryMemberId,
            targetMemberId: replicaMemberId,
            epoch: 0,
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
          error:
            'managed.apply switchover re-seed refused: it belongs to another switchover (stale recovery); the data directory was not touched',
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const [row] = await db
        .select({ status: managed.status })
        .from(managed)
        .where(eq(managed.id, managedId))
      assertEquals(row?.status, 'ready')
      const [former] = await db
        .select({ role: replica.role, status: replica.status })
        .from(replica)
        .where(eq(replica.id, primaryMemberId))
      assertEquals(former, { role: 'replica', status: 'needs_resync' })
      const stored = await findRecoveryById(db, created.id)
      assertEquals(stored?.metadata.reseedState, 'failed')
      assertEquals(stored?.metadata.reseedNote?.includes('stale recovery'), true)
      assertEquals((await getCommandRecord(db, record.id))?.status, 'failed')
    } finally {
      await db.delete(recoveryTable).where(eq(recoveryTable.managedId, managedId))
      await cleanUpPromotePair(db, { serverId, managedId, standbyServerId })
    }
  })
})

test('a switchover fence stop result stores the old primary final position on the recovery row', async () => {
  await withManagedDestroyFixtures(async (f) => {
    try {
      const metadata = await runSwitchoverStop(f, {
        status: 'stopped',
        oldPrimaryFinalLsn: '0/7258050',
        oldPrimaryFinalTimeline: 1,
      })
      assertEquals(metadata.oldPrimaryFinalLsn, '0/7258050')
      assertEquals(metadata.oldPrimaryFinalTimeline, 1)
      assertEquals(metadata.stopApplied, true)
    } finally {
      await f.db.delete(recoveryTable).where(eq(recoveryTable.managedId, f.managedId))
      await f.db.delete(replica).where(eq(replica.managedId, f.managedId))
    }
  })
})

test('a stop result from a daemon that reports no position, or a malformed one, stores nothing', async () => {
  for (const result of [
    { status: 'stopped' },
    { status: 'stopped', oldPrimaryFinalLsn: '0/7258050' },
    { status: 'stopped', oldPrimaryFinalLsn: 'nonsense', oldPrimaryFinalTimeline: 1 },
  ]) {
    await withManagedDestroyFixtures(async (f) => {
      try {
        const metadata = await runSwitchoverStop(f, result)
        assertEquals(metadata.oldPrimaryFinalLsn, undefined)
        assertEquals(metadata.oldPrimaryFinalTimeline, undefined)
        assertEquals(metadata.stopApplied, true)
      } finally {
        await f.db.delete(recoveryTable).where(eq(recoveryTable.managedId, f.managedId))
        await f.db.delete(replica).where(eq(replica.managedId, f.managedId))
      }
    })
  }
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

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
      commandQueue: queue,
    })

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

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
      commandQueue: queue,
    })

    assertEquals(queue.envelopes.length, 0)
  })
})

test('processCommandEnvelope deletes member only after destroy success with deleteMemberAfterDestroy', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const [memberRow] = await db
      .insert(replica)
      .values({
        managedId,
        serverId,
        role: 'replica',
        ordinal: 2,
        status: 'applying',
        isReadEligible: true,
      })
      .returning({ id: replica.id })
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const [after] = await db
        .select({ id: replica.id })
        .from(replica)
        .where(eq(replica.id, memberId))
        .limit(1)
      assertEquals(after, undefined)
    } finally {
      await db.delete(replica).where(eq(replica.managedId, managedId))
    }
  })
})

/**
 * Three servers in one datacenter: primary member, standby member, and a
 * **third** server that hosts no engine member but runs a compose service
 * bound to the cluster. The promote fan-out has to reach that consumer host —
 * its ProxySQL is what routes the app's writes.
 */
type PromoteConsumerFixture = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  primaryServerId: string
  standbyServerId: string
  consumerServerId: string
  managedId: string
  primaryMemberId: string
  standbyMemberId: string
  bindingId: string
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
}

async function insertPromoteFixtureServer(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  name: string
): Promise<string> {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({ createdAt: now, updatedAt: now, organizationId, name })
    .returning({ id: server.id })
  const serverId = row!.id
  await attachConnectedDaemonStatus(db, serverId)
  return serverId
}

/**
 * Delete every workspace-tree / network row this organization owns.
 *
 * `buildManagedIngressReconcilePayload` self-heals a managed-ingress
 * hierarchy per reconciled server, so the fan-out creates rows the test never
 * named; sweeping by organization keeps `RESTRICT` foreign keys from blocking
 * the `server` / `organization` deletes.
 */
async function sweepPromoteFixtureOrganization(
  db: ReturnType<typeof createDenoDb>,
  organizationId: string,
  serverIds: readonly string[]
): Promise<void> {
  const workspaceIds = (
    await db
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.organizationId, organizationId))
  ).map((row) => row.id)
  const projectIds =
    workspaceIds.length === 0
      ? []
      : (
          await db
            .select({ id: project.id })
            .from(project)
            .where(inArray(project.workspaceId, workspaceIds))
        ).map((row) => row.id)
  const environmentIds =
    projectIds.length === 0
      ? []
      : (
          await db
            .select({ id: environment.id })
            .from(environment)
            .where(inArray(environment.projectId, projectIds))
        ).map((row) => row.id)
  const serviceIds =
    environmentIds.length === 0
      ? []
      : (
          await db
            .select({ id: service.id })
            .from(service)
            .where(inArray(service.environmentId, environmentIds))
        ).map((row) => row.id)
  const managedIds =
    environmentIds.length === 0
      ? []
      : (
          await db
            .select({ id: managed.id })
            .from(managed)
            .where(inArray(managed.environmentId, environmentIds))
        ).map((row) => row.id)

  if (serviceIds.length > 0) {
    await db.delete(variable).where(inArray(variable.serviceId, serviceIds))
    await db.delete(binding).where(inArray(binding.serviceId, serviceIds))
  }
  if (managedIds.length > 0) {
    await db.delete(replica).where(inArray(replica.managedId, managedIds))
  }
  // Ingress hierarchy self-heal allocates containers on every reconciled
  // server, including the outer fixture's server — sweep by organization so
  // its own teardown is not blocked by a `RESTRICT` container reference.
  const orgServerIds = (
    await db.select({ id: server.id }).from(server).where(eq(server.organizationId, organizationId))
  ).map((row) => row.id)
  if (orgServerIds.length > 0) {
    await db.delete(container).where(inArray(container.serverId, orgServerIds))
  }
  if (serviceIds.length > 0) {
    await db.delete(service).where(inArray(service.id, serviceIds))
  }
  if (managedIds.length > 0) {
    await db.delete(managed).where(inArray(managed.id, managedIds))
  }
  if (environmentIds.length > 0) {
    await db.delete(environment).where(inArray(environment.id, environmentIds))
  }
  if (projectIds.length > 0) {
    await db.delete(project).where(inArray(project.id, projectIds))
  }
  await db.delete(ip).where(eq(ip.organizationId, organizationId))
  await db.delete(network).where(eq(network.organizationId, organizationId))
  await db.delete(datacenter).where(eq(datacenter.organizationId, organizationId))
  await db.delete(command).where(inArray(command.serverId, [...serverIds]))
  await db.delete(server).where(inArray(server.id, [...serverIds]))
  if (workspaceIds.length > 0) {
    await db.delete(workspace).where(inArray(workspace.id, workspaceIds))
  }
  await db.delete(tls).where(eq(tls.organizationId, organizationId))
}

async function withPromoteConsumerFixtures(
  fn: (ctx: PromoteConsumerFixture) => Promise<void>
): Promise<void> {
  await withConsumerFixtures(async ({ db, organizationId, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const secretsConfig = parseTestSecretsConfig('deno')
    const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
      secretsConfig,
      'data-encryption'
    )

    const standbyServerId = await insertPromoteFixtureServer(
      db,
      organizationId,
      'Promote Fan-out Standby'
    )
    const consumerServerId = await insertPromoteFixtureServer(
      db,
      organizationId,
      'Promote Fan-out Consumer'
    )
    const extraServerIds = [standbyServerId, consumerServerId]

    try {
      const now = new Date().toISOString()
      // Shared datacenter so ProxySQL on the consumer host has a private path
      // to both engine members (`local → datacenter` ladder).
      const [dcRow] = await db
        .insert(datacenter)
        .values({
          organizationId,
          name: 'Promote Fan-out DC',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: datacenter.id })
      const [netRow] = await db
        .insert(network)
        .values({
          organizationId,
          datacenterId: dcRow!.id,
          kind: 'datacenter',
          cidr: '10.40.50.0/24',
          name: 'Promote Fan-out LAN',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: network.id })
      const pins: Array<[string, string]> = [
        [serverId, '10.40.50.11'],
        [standbyServerId, '10.40.50.12'],
        [consumerServerId, '10.40.50.13'],
      ]
      for (const [pinServerId, address] of pins) {
        await db.insert(ip).values({
          organizationId,
          datacenterId: dcRow!.id,
          networkId: netRow!.id,
          serverId: pinServerId,
          address,
          allocation: 'dedicated',
          scope: 'datacenter',
          createdAt: now,
          updatedAt: now,
        })
      }

      const [workspaceRow] = await db
        .insert(workspace)
        .values({ organizationId, name: 'Promote Fan-out Workspace' })
        .returning({ id: workspace.id })
      const [managedProjectRow] = await db
        .insert(project)
        .values({
          workspaceId: workspaceRow!.id,
          organizationId,
          name: 'Promote Fan-out Database',
          kind: 'managed',
          metadata: { code: 'postgres' },
        })
        .returning({ id: project.id })
      const [managedEnvironmentRow] = await db
        .insert(environment)
        .values({
          projectId: managedProjectRow!.id,
          serverId,
          name: 'production',
        })
        .returning({ id: environment.id })
      const [managedRow] = await db
        .insert(managed)
        .values({
          environmentId: managedEnvironmentRow!.id,
          serverId,
          name: 'Promote Fan-out Postgres',
          engine: 'postgres',
          status: 'ready',
          metadata: {},
          options: { settings: {} },
        })
        .returning({ id: managed.id })
      const managedId = managedRow!.id

      const [primaryMemberRow] = await db
        .insert(replica)
        .values({
          managedId,
          serverId,
          role: 'primary',
          ordinal: 1,
          status: 'ready',
          privatePort: 45001,
        })
        .returning({ id: replica.id })
      const [standbyMemberRow] = await db
        .insert(replica)
        .values({
          managedId,
          serverId: standbyServerId,
          role: 'replica',
          replicaClass: 'failover',
          ordinal: 2,
          status: 'ready',
          privatePort: 45002,
        })
        .returning({ id: replica.id })

      // Engine containers: a local member's ProxySQL backend address is its
      // Docker container name, so `managed.ingress.reconcile` cannot be built
      // for a member server without an allocated `container` row.
      const [engineServiceRow] = await db
        .insert(service)
        .values({
          environmentId: managedEnvironmentRow!.id,
          name: 'postgres',
          composeServiceName: 'postgres',
        })
        .returning({ id: service.id })
      for (const [engineServerId, ordinal] of [
        [serverId, 1],
        [standbyServerId, 2],
      ] as const) {
        await db.insert(container).values({
          serviceId: engineServiceRow!.id,
          serverId: engineServerId,
          containerName: `managed-postgres-${ordinal}`,
          composeServiceName: 'postgres',
          role: 'service',
          ordinal,
          status: 'running',
        })
      }

      const [pgDatabase] = await db
        .insert(managedDatabase)
        .values({ managedId, name: 'postgres' })
        .returning({ id: managedDatabase.id })
      const rootLogin = await createManagedLogin(db, dataEncryptionSecrets, {
        managedId,
        role: 'root',
        username: 'postgres',
      })

      // Consumer app on the third server, bound to the cluster.
      const [consumerProjectRow] = await db
        .insert(project)
        .values({
          workspaceId: workspaceRow!.id,
          organizationId,
          name: 'Promote Fan-out App',
          kind: 'compose',
        })
        .returning({ id: project.id })
      const [consumerEnvironmentRow] = await db
        .insert(environment)
        .values({
          projectId: consumerProjectRow!.id,
          serverId: consumerServerId,
          name: 'production',
        })
        .returning({ id: environment.id })
      const [consumerServiceRow] = await db
        .insert(service)
        .values({
          environmentId: consumerEnvironmentRow!.id,
          name: 'api',
          composeServiceName: 'api',
        })
        .returning({ id: service.id })
      const [bindingRow] = await db
        .insert(binding)
        .values({
          loginId: rootLogin.loginId,
          serviceId: consumerServiceRow!.id,
          databaseId: pgDatabase!.id,
          keyPrefix: 'DB',
        })
        .returning({ id: binding.id })

      await fn({
        db,
        organizationId,
        primaryServerId: serverId,
        standbyServerId,
        consumerServerId,
        managedId,
        primaryMemberId: primaryMemberRow!.id,
        standbyMemberId: standbyMemberRow!.id,
        bindingId: bindingRow!.id,
        secretsConfig,
        dataEncryptionSecrets,
      })
    } finally {
      await sweepPromoteFixtureOrganization(db, organizationId, extraServerIds)
    }
  })
}

test('processCommandEnvelope fans promote ingress reconcile out to bound consumer servers', async () => {
  await withPromoteConsumerFixtures(
    async ({
      db,
      organizationId,
      primaryServerId,
      standbyServerId,
      consumerServerId,
      managedId,
      primaryMemberId,
      standbyMemberId,
      bindingId,
      secretsConfig,
      dataEncryptionSecrets,
    }) => {
      const before = await db
        .select({ id: variable.id })
        .from(variable)
        .where(eq(variable.bindingId, bindingId))
      assertEquals(before.length, 0)

      const queue = createRecordingCommandQueue()
      const record = await createCommandRecord(db, {
        serverId: standbyServerId,
        ...TEST_COMMAND_ACTOR,
        type: 'managed.promote',
        payload: {
          managedId,
          memberId: standbyMemberId,
          engine: 'postgres',
          demoteMemberId: primaryMemberId,
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
            promotedMemberId: standbyMemberId,
            demotedMemberId: primaryMemberId,
            status: 'ready',
            summary: 'promoted',
          },
        },
      })

      await processCommandEnvelope(db, registry, buildEnvelope(record, standbyServerId), {
        firewallApplyGate: DENY_FIREWALL_APPLY,
        commandQueue: queue,
        secretsConfig,
        dataEncryptionSecrets,
      })

      assertEquals(await getCommandRecord(db, record.id).then((r) => r?.status), 'succeeded')

      // Member servers **and** the consuming server all reconcile ProxySQL: the
      // consumer's frontend is what routes app writes at the new primary.
      const reconciledServerIds = new Set(
        queue.envelopes
          .filter((envelope) => envelope.type === 'managed.ingress.reconcile')
          .map((envelope) => envelope.serverId)
      )
      assertEquals(reconciledServerIds.has(primaryServerId), true)
      assertEquals(reconciledServerIds.has(standbyServerId), true)
      assertEquals(reconciledServerIds.has(consumerServerId), true)

      // Binding-owned HOST/PORT variables are re-materialized against the
      // consumer host's ProxySQL listener, not the demoted primary's engine.
      const materialized = await db
        .select({ key: variable.key, value: variable.value })
        .from(variable)
        .where(eq(variable.bindingId, bindingId))
      const byKey = new Map(materialized.map((row) => [row.key, row.value]))
      const hierarchy = await ensureManagedIngressHierarchy(db, {
        organizationId,
        serverId: consumerServerId,
      })
      assertEquals(byKey.get('DB_HOST'), hierarchy.containerName)
      assertEquals(byKey.get('DB_PORT'), '15432')
    }
  )
})

test('processCommandEnvelope keeps member row failed/retryable when destroy fails', async () => {
  await withManagedDestroyFixtures(async ({ db, serverId, managedId }) => {
    const [memberRow] = await db
      .insert(replica)
      .values({
        managedId,
        serverId,
        role: 'replica',
        ordinal: 2,
        status: 'applying',
        isReadEligible: true,
      })
      .returning({ id: replica.id })
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

      await processCommandEnvelope(db, registry, buildEnvelope(record, serverId))

      const [after] = await db
        .select({ id: replica.id, status: replica.status })
        .from(replica)
        .where(eq(replica.id, memberId))
        .limit(1)
      assertEquals(after?.id, memberId)
      assertEquals(after?.status, 'failed')
    } finally {
      await db.delete(replica).where(eq(replica.managedId, managedId))
    }
  })
})

test('processCommandEnvelope leaves a folder row alone when it changed after the reconcile command was built', async () => {
  await withDeployFixtures(async (ctx) => {
    await attachConnectedDaemonStatus(ctx.db, ctx.serverId)
    await withOwnerFolders(
      ctx,
      [{ owner: 'one', kind: 'volume', slug: 'busy', state: 'present' }],
      async ({ one }) => {
        const record = await createCommandRecord(ctx.db, {
          serverId: ctx.serverId,
          ...TEST_COMMAND_ACTOR,
          type: 'server.principals.reconcile',
          payload: { principals: [] },
        })
        // A deploy touched the row after the command was built, so a listing taken
        // for that command cannot be trusted about it.
        await ctx.db
          .update(folder)
          .set({ state: 'present' })
          .where(eq(folder.serverId, ctx.serverId))
        const registry = createDispatchMockRegistry(ctx.serverId, {
          waitForRequestResult: {
            serverId: ctx.serverId,
            requestId: record.id,
            requestKind: 'command-dispatch',
            status: 'done',
            createdAt: record.createdAt,
            expiresAt: record.createdAt,
            finishedAt: new Date().toISOString(),
            result: {
              principalsApplied: 0,
              keysChanged: [],
              keysRemoved: [],
              sshdReloaded: false,
              sftpChroot: false,
              folders: [],
              warnings: [],
            },
          },
        })
        await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId))
        assertEquals(await folderStates(ctx.db, ctx.serverId), { 'volume:busy': 'present' })
        assertEquals(one.login.length > 0, true)
      }
    )
  })
})

/** A registry whose cell reports the given request and never delivers a result by itself. */
function registryWithRequest(
  serverId: string,
  request: (requestId: string) => PendingRequestRecord | null
) {
  const registry = createDispatchMockRegistry(serverId, { waitForRequestResult: null })
  const base = registry.getCell(serverId)
  const cell = { ...base, getRequest: (id: string) => Promise.resolve(request(id)) }
  return Object.assign(registry, { getCell: () => cell as DaemonCell })
}

function fakeQueue() {
  const sent: CommandEnvelope[] = []
  const queue: CommandQueue = {
    enqueue: (envelope) => {
      sent.push(envelope)
      return Promise.resolve()
    },
  }
  return { sent, queue }
}

async function sentDeploy(
  db: ReturnType<typeof createDenoDb>,
  serverId: string,
  opts: { sentAgoMs: number; runningSinceAgoMs?: number | null }
) {
  const record = await createCommandRecord(db, {
    serverId,
    ...TEST_COMMAND_ACTOR,
    type: 'environment.deploy',
    payload: { notAnEnvironmentId: true },
  })
  const sentAt = new Date(Date.now() - opts.sentAgoMs).toISOString()
  await transitionCommand(db, record.id, { status: 'sent', sentAt })
  if (opts.runningSinceAgoMs !== undefined) {
    const runningSince =
      opts.runningSinceAgoMs === null
        ? null
        : new Date(Date.now() - opts.runningSinceAgoMs).toISOString()
    await db
      .update(command)
      .set({
        progress: { version: 1, steps: [], current: null, updatedAt: sentAt, runningSince },
      })
      .where(eq(command.id, record.id))
  }
  return record
}

const ACKED_REQUEST = (serverId: string, id: string): PendingRequestRecord => ({
  serverId,
  requestId: id,
  requestKind: 'command-dispatch',
  status: 'acked',
  createdAt: new Date().toISOString(),
  expiresAt: new Date().toISOString(),
  ackAt: new Date().toISOString(),
})

test('a deploy that waited hours for the server is handed back to the queue, not timed out', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await sentDeploy(db, serverId, {
      sentAgoMs: 3 * 60 * 60_000,
      runningSinceAgoMs: null,
    })
    const registry = registryWithRequest(serverId, (id) => ACKED_REQUEST(serverId, id))
    const { sent, queue } = fakeQueue()

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      commandQueue: queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
    })

    assertEquals(sent.length, 1)
    assertEquals(sent[0]?.commandId, record.id)
    assertEquals(registry.enqueueCalled, false)
    assertEquals((await getCommandRecord(db, record.id))?.status, 'sent')
  })
})

test('a deploy the server already has gives up its server lane while it is waited on', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await sentDeploy(db, serverId, {
      sentAgoMs: 3 * 60 * 60_000,
      runningSinceAgoMs: null,
    })
    const registry = registryWithRequest(serverId, (id) => ACKED_REQUEST(serverId, id))
    const { sent, queue } = fakeQueue()
    let lanesLeft = 0

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      commandQueue: queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
      leaveLane: () => {
        lanesLeft += 1
      },
    })

    // The lane was freed for the server's other commands before the wait was handed back.
    assertEquals(lanesLeft, 1)
    assertEquals(sent.length, 1)
    assertEquals((await getCommandRecord(db, record.id))?.status, 'sent')
  })
})

test('a deploy that has been running longer than the run cap times out, counted from its start', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await sentDeploy(db, serverId, {
      sentAgoMs: 3 * 60 * 60_000,
      runningSinceAgoMs: 11 * 60_000,
    })
    const registry = registryWithRequest(serverId, (id) => ACKED_REQUEST(serverId, id))

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
    })

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'timed_out')
    assertEquals(updated?.error?.includes('10 minutes'), true)
  })
})

test('a deploy started a minute ago is not timed out even though it was sent hours ago', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await sentDeploy(db, serverId, {
      sentAgoMs: 3 * 60 * 60_000,
      runningSinceAgoMs: 9 * 60_000 + 55_000,
    })
    let looks = 0
    const registry = registryWithRequest(serverId, (id) => {
      looks += 1
      return looks < 2
        ? ACKED_REQUEST(serverId, id)
        : { ...ACKED_REQUEST(serverId, id), status: 'done', result: { containers: [] } }
    })

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
    })

    assertEquals((await getCommandRecord(db, record.id))?.status, 'succeeded')
  })
})

test('a deploy that was already sent is waited for again, not sent twice', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await sentDeploy(db, serverId, { sentAgoMs: 60_000 })
    const registry = registryWithRequest(serverId, (id) => ({
      ...ACKED_REQUEST(serverId, id),
      status: 'done',
      finishedAt: new Date().toISOString(),
      result: { containers: [] },
    }))

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
    })

    assertEquals(registry.enqueueCalled, false)
    assertEquals((await getCommandRecord(db, record.id))?.status, 'succeeded')
  })
})

test('a deploy sent to a server that stays offline fails with plain words after the offline limit', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await sentDeploy(db, serverId, { sentAgoMs: 16 * 60_000 })
    const registry = registryWithRequest(serverId, (id) => ({
      ...ACKED_REQUEST(serverId, id),
      status: 'queued',
    }))

    await processCommandEnvelope(db, registry, buildEnvelope(record, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
    })

    const updated = await getCommandRecord(db, record.id)
    assertEquals(updated?.status, 'timed_out')
    assertEquals(updated?.error?.includes('offline'), true)
  })
})

test('the start is when the control plane first hears the server is running, and a later report does not move it', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    const record = await sentDeploy(db, serverId, { sentAgoMs: 60_000 })
    const frame = (runningSince: string | null) => ({
      version: 1,
      steps: [],
      current: null,
      updatedAt: new Date().toISOString(),
      runningSince,
    })
    const before = Date.now()
    const started = '2026-10-21T10:00:00.000Z'
    await recordCommandProgress(db, { serverId, commandId: record.id, progress: frame(started) })
    await recordCommandProgress(db, { serverId, commandId: record.id, progress: frame(null) })
    await recordCommandProgress(db, {
      serverId,
      commandId: record.id,
      progress: frame('2026-10-21T10:30:00.000Z'),
    })
    const stored = await getCommandRecord(db, record.id)
    // The start is when the control plane first heard it, whatever the server's clock says.
    const startedMs = Date.parse(stored?.startedAt ?? '')
    assertEquals(startedMs >= before && startedMs <= Date.now(), true)
    assertEquals(Date.parse(stored?.progress?.runningSince ?? '') >= startedMs, true)
  })
})

test('a deploy is sent with a request lifetime longer than the queue limit, other commands are not', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const deploy = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'environment.deploy',
      payload: { notAnEnvironmentId: true },
    })
    const registry = createDispatchMockRegistry(serverId, {
      waitForRequestResult: { ...ACKED_REQUEST(serverId, deploy.id), status: 'done' },
    })
    await processCommandEnvelope(db, registry, buildEnvelope(deploy, serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
    })
    assertEquals((registry.enqueueOpts?.ttlSeconds ?? 0) > 6 * 60 * 60, true)
  })
})

// --- A deploy whose server goes quiet is checked on, not failed ------------------------------

const MIN = 60_000

type QuietDeployOptions = {
  ctx: { db: ReturnType<typeof createDenoDb>; organizationId: string; serverId: string }
  environmentId: string
  projectId: string
  /** How long ago the deploy started running. */
  ranMs: number
  /** How long ago the server last reported. */
  silentMs: number
  recovery: boolean
}

/** A deploy the server has been running, with a step plan, a deployment row and a quiet server. */
async function quietDeploy(opts: QuietDeployOptions) {
  const { db, organizationId, serverId } = opts.ctx
  await attachConnectedDaemonStatus(db, serverId)
  await touchServerMetadata(db, serverId, {
    features: opts.recovery ? ['command-recovery-v1'] : [],
  })
  const record = await createCommandRecord(db, {
    serverId,
    ...TEST_COMMAND_ACTOR,
    type: 'environment.deploy',
    payload: {
      environmentId: opts.environmentId,
      projectId: opts.projectId,
      organizationId,
      projectName: 'tp-deploy-test',
      composeFiles: [
        {
          filename: 'compose.yaml',
          role: 'runtime',
          source: 'inline',
          content: 'services:\n  web:\n    image: nginx\n',
        },
      ],
      hostings: [],
      deployStrategy: 'sequential',
      generation: 2,
    },
    context: { environmentId: opts.environmentId, generation: 2 },
  })
  await db.delete(deployment).where(eq(deployment.serverId, serverId))
  await db.insert(deployment).values({
    environmentId: opts.environmentId,
    serverId,
    desiredGeneration: 2,
    appliedGeneration: 1,
    status: 'applying',
    lastCommandId: record.id,
  })
  const now = Date.now()
  const sentAt = new Date(now - opts.ranMs - MIN).toISOString()
  await transitionCommand(db, record.id, { status: 'sent', sentAt })
  await db
    .update(command)
    .set({
      progress: {
        version: 1,
        steps: [
          { id: 'install', label: 'Install running', state: 'done' },
          { id: 'build', label: 'Build running', state: 'running' },
        ],
        current: 'build',
        updatedAt: sentAt,
        runningSince: new Date(now - opts.ranMs).toISOString(),
      },
      updatedAt: new Date(now - opts.silentMs).toISOString(),
    })
    .where(eq(command.id, record.id))
  return record
}

function ackedUntilDone(serverId: string, done: PendingRequestRecord | null) {
  let looks = 0
  return registryWithRequest(serverId, (id) => {
    looks += 1
    if (done !== null && looks > 1) return { ...done, requestId: id }
    return ACKED_REQUEST(serverId, id)
  })
}

async function readProgress(db: ReturnType<typeof createDenoDb>, id: string) {
  const [row] = await db
    .select({ progress: command.progress })
    .from(command)
    .where(eq(command.id, id))
  return row?.progress as { contactLostAt?: string | null } | null
}

test('a quiet running deploy is kept as checking with the server, not failed', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 12 * MIN,
      silentMs: 8 * MIN,
      recovery: true,
    })
    const registry = registryWithRequest(ctx.serverId, (id) => ACKED_REQUEST(ctx.serverId, id))
    const { sent, queue } = fakeQueue()

    await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId), {
      commandQueue: queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
      deployWaitEndMs: 0,
    })

    assertEquals(sent.length, 1)
    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'sent')
    assertEquals(typeof (await readProgress(ctx.db, record.id))?.contactLostAt, 'string')
  })
})

test('a result that arrives after the server was quiet settles the deploy as succeeded', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 40 * MIN,
      silentMs: 30 * MIN,
      recovery: true,
    })
    const done: PendingRequestRecord = {
      ...ACKED_REQUEST(ctx.serverId, record.id),
      status: 'done',
      finishedAt: new Date().toISOString(),
      result: { containers: [] },
    }

    await processCommandEnvelope(
      ctx.db,
      ackedUntilDone(ctx.serverId, done),
      buildEnvelope(record, ctx.serverId),
      {
        firewallApplyGate: DENY_FIREWALL_APPLY,
      }
    )

    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'succeeded')
    assertEquals(stored?.progress?.contactLostAt ?? null, null)
    const [row] = await ctx.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.serverId, ctx.serverId))
    assertEquals(row?.status, 'applied')
  })
})

test('a failure the server reports after it was quiet settles the deploy as failed with its own words', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 20 * MIN,
      silentMs: 10 * MIN,
      recovery: true,
    })
    const failed: PendingRequestRecord = {
      ...ACKED_REQUEST(ctx.serverId, record.id),
      status: 'failed',
      error: 'The daemon restarted while this command was running (last step: Build running).',
    }

    await processCommandEnvelope(
      ctx.db,
      ackedUntilDone(ctx.serverId, failed),
      buildEnvelope(record, ctx.serverId),
      {
        firewallApplyGate: DENY_FIREWALL_APPLY,
      }
    )

    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'failed')
    assertEquals(stored?.error?.includes('daemon restarted'), true)
  })
})

test('a deploy the server never reports on is failed only after the whole reconcile window, naming the last step', async () => {
  await withDeployFixtures(async (ctx) => {
    const quietFor = async (silentMs: number) => {
      const record = await quietDeploy({
        ctx,
        environmentId: ctx.environmentId,
        projectId: ctx.projectId,
        ranMs: silentMs + 5 * MIN,
        silentMs,
        recovery: true,
      })
      const registry = registryWithRequest(ctx.serverId, (id) => ACKED_REQUEST(ctx.serverId, id))
      await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId), {
        commandQueue: fakeQueue().queue,
        firewallApplyGate: DENY_FIREWALL_APPLY,
        deployWaitHoldMs: 0,
        deployWaitEndMs: 0,
      })
      return getCommandRecord(ctx.db, record.id)
    }

    // Just under six hours quiet: still checking (no queue here, so the wait is held).
    const waiting = await quietFor(5 * 60 * MIN + 50 * MIN)
    assertEquals(waiting?.status, 'sent')

    const given = await quietFor(6 * 60 * MIN + MIN)
    assertEquals(given?.status, 'timed_out')
    assertEquals(given?.error?.includes('Lost contact with the server'), true)
    assertEquals(given?.error?.includes('Last known step: Build running'), true)
    assertEquals(given?.error?.includes('still running after 10 minutes'), false)
  })
})

test('the deploy time limit of 30 minutes holds only while the server reports', async () => {
  await withDeployFixtures(async (ctx) => {
    const run = async (ranMs: number) => {
      const record = await quietDeploy({
        ctx,
        environmentId: ctx.environmentId,
        projectId: ctx.projectId,
        ranMs,
        silentMs: 20_000,
        recovery: true,
      })
      const registry = registryWithRequest(ctx.serverId, (id) => ACKED_REQUEST(ctx.serverId, id))
      await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId), {
        commandQueue: fakeQueue().queue,
        firewallApplyGate: DENY_FIREWALL_APPLY,
        deployWaitHoldMs: 0,
        deployWaitEndMs: 0,
      })
      return getCommandRecord(ctx.db, record.id)
    }

    // Reporting all along and past 30 minutes: stopped, with the real reason.
    const over = await run(45 * MIN)
    assertEquals(over?.status, 'timed_out')
    assertEquals(over?.error?.includes('30 minutes'), true)

    // Reporting and past the old ten minute cap, inside the limit: still running.
    const allowed = await run(25 * MIN)
    assertEquals(allowed?.status, 'sent')
  })
})

test("the deploy time limit is the one the server's organization set", async () => {
  await withDeployFixtures(async (ctx) => {
    assertEquals(await loadDeployRunCapMs(ctx.db, ctx.serverId), 30 * MIN)
    const setLimit = (deployTimeoutMinutes: number | null) =>
      ctx.db
        .update(organization)
        .set({ deployTimeoutMinutes })
        .where(eq(organization.id, ctx.organizationId))
    await setLimit(90)
    assertEquals(await loadDeployRunCapMs(ctx.db, ctx.serverId), 90 * MIN)
    await assertRejects(() => setLimit(1000))
    await assertRejects(() => setLimit(4))
    assertEquals(await loadDeployRunCapMs(ctx.db, ctx.serverId), 90 * MIN)
    await setLimit(null)
    assertEquals(await loadDeployRunCapMs(ctx.db, ctx.serverId), 30 * MIN)

    await setLimit(90)
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 45 * MIN,
      silentMs: 20_000,
      recovery: true,
    })
    const registry = registryWithRequest(ctx.serverId, (id) => ACKED_REQUEST(ctx.serverId, id))
    await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId), {
      commandQueue: fakeQueue().queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
      deployWaitEndMs: 0,
    })
    // Past 30 minutes but inside the organization's 90: still running, not stopped.
    assertEquals((await getCommandRecord(ctx.db, record.id))?.status, 'sent')
  })
})

test('a server without sign-of-life reports keeps the fixed cap, worded as no result rather than a stop', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 11 * MIN,
      silentMs: 11 * MIN,
      recovery: false,
    })
    const registry = registryWithRequest(ctx.serverId, (id) => ACKED_REQUEST(ctx.serverId, id))

    await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
    })

    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'timed_out')
    assertEquals(stored?.error?.includes('No result came back'), true)
    assertEquals(stored?.error?.includes('may still have finished'), true)
  })
})

type DeployFixtures = Parameters<Parameters<typeof withDeployFixtures>[0]>[0]

/** A deploy on a server that confirms results, given up on as `timed_out` after hours of silence. */
async function timedOutDeploy(ctx: DeployFixtures) {
  const record = await quietDeploy({
    ctx,
    environmentId: ctx.environmentId,
    projectId: ctx.projectId,
    ranMs: 7 * 60 * MIN,
    silentMs: 7 * 60 * MIN,
    recovery: true,
  })
  const registry = registryWithRequest(ctx.serverId, (id) => ACKED_REQUEST(ctx.serverId, id))
  await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId), {
    firewallApplyGate: DENY_FIREWALL_APPLY,
    deployWaitHoldMs: 0,
  })
  assertEquals((await getCommandRecord(ctx.db, record.id))?.status, 'timed_out')
  return record
}

/** A late `command-outcome` saying the command succeeded. */
function lateSuccess(requestId: string, result: unknown = { containers: [] }) {
  return {
    kind: 'command-outcome' as const,
    requestId,
    at: new Date().toISOString(),
    ok: true,
    result,
  }
}

test('a result that arrives after the deploy was given up on corrects it to succeeded, once', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await timedOutDeploy(ctx)

    const envelope = {
      kind: 'command-outcome' as const,
      requestId: record.id,
      at: new Date().toISOString(),
      ok: true,
      result: { containers: [] },
    }
    const failedLate = await settleReportedOutcome(ctx.db, {
      serverId: ctx.serverId,
      envelope: { ...envelope, ok: false, error: 'boom' },
      record: null,
    })
    assertEquals(failedLate, true)
    assertEquals((await getCommandRecord(ctx.db, record.id))?.status, 'timed_out')

    const first = await settleReportedOutcome(ctx.db, {
      serverId: ctx.serverId,
      envelope,
      record: null,
    })
    const second = await settleReportedOutcome(ctx.db, {
      serverId: ctx.serverId,
      envelope,
      record: null,
    })
    assertEquals([first, second], [true, true])

    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'succeeded')
    assertEquals(stored?.error ?? null, null)
    assertEquals(
      stored?.progress?.steps.every((step) => step.state === 'done'),
      true
    )
    const [meta] = await ctx.db
      .select({ metadata: command.metadata })
      .from(command)
      .where(eq(command.id, record.id))
    assertEquals(
      (meta?.metadata as { lateOutcome?: { note: string } }).lateOutcome?.note,
      LATE_OUTCOME_NOTE
    )
    const [row] = await ctx.db
      .select({ status: deployment.status, applied: deployment.appliedGeneration })
      .from(deployment)
      .where(eq(deployment.serverId, ctx.serverId))
    assertEquals(row?.status, 'applied')
    assertEquals(row?.applied, 2)
  })
})

test('a late success for a deploy whose project was deleted is confirmed and writes nothing for it', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await timedOutDeploy(ctx)
    assertEquals((await deleteProjectCascade(ctx.db, ctx.projectId)).ok, true)

    const replies: unknown[] = []
    const at = new Date().toISOString()
    await dispatchDaemonInboundMessage({
      cell: expiringCellRequests(ctx.serverId, 0).registry.getCell(ctx.serverId),
      db: ctx.db,
      serverId: ctx.serverId,
      connectionId: 'conn-late-result',
      message: {
        type: 'command-outcome',
        id: record.id,
        ok: true,
        at,
        daemonRespondedAt: at,
        result: {
          projectName: 'tp-deploy-test',
          containers: [
            {
              composeServiceName: 'web',
              containerId: 'late-cid',
              containerName: 'tp-deploy-test-web-1',
              status: 'running',
              role: 'service',
            },
          ],
        },
      },
      reply: (message) => replies.push(message),
    })

    assertEquals(replies.length, 1)
    assertEquals((replies[0] as { type: string }).type, 'command-outcome-ack')
    assertEquals((replies[0] as { id: string }).id, record.id)
    assertEquals((await getCommandRecord(ctx.db, record.id))?.status, 'succeeded')
    const deployments = await ctx.db
      .select({ id: deployment.id })
      .from(deployment)
      .where(eq(deployment.environmentId, ctx.environmentId))
    assertEquals(deployments, [])
    const containers = await ctx.db
      .select({ id: container.id })
      .from(container)
      .where(eq(container.serverId, ctx.serverId))
    assertEquals(containers, [])
    assertEquals(await getCommandDispatchPayload(ctx.db, record.id), null)
  })
})

test('a late success whose report the database refuses is still confirmed, with the status corrected', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await timedOutDeploy(ctx)
    // Postgres refuses a NUL character inside jsonb, so the full correction fails.
    const envelope = lateSuccess(record.id, {
      projectName: 'tp-deploy-test',
      warnings: ['build printed \u0000'],
    })

    const ack = await ackForReportedOutcome(ctx.db, {
      serverId: ctx.serverId,
      envelope,
      record: null,
    })

    assertEquals(ack?.type, 'command-outcome-ack')
    assertEquals(ack?.id, record.id)
    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'succeeded')
    assertEquals(stored?.error ?? null, null)
    assertEquals(stored?.result ?? null, null)
    const [meta] = await ctx.db
      .select({ metadata: command.metadata })
      .from(command)
      .where(eq(command.id, record.id))
    assertEquals(
      (meta?.metadata as { lateOutcome?: { note: string } }).lateOutcome?.note,
      LATE_OUTCOME_NOTE
    )
  })
})

test('a late success is confirmed even when the deploy records cannot be updated', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await timedOutDeploy(ctx)
    // Only this test's deployment row refuses writes, so the side effects fail.
    const refuse = sql.raw(`tp_refuse_${ctx.environmentId.replaceAll('-', '')}`)
    await ctx.db.execute(
      sql`CREATE FUNCTION ${refuse}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deployment row is read-only'; END $$`
    )
    await ctx.db.execute(
      sql`CREATE TRIGGER ${refuse} BEFORE UPDATE ON deployment FOR EACH ROW WHEN (OLD.environment_id = ${sql.raw(`'${ctx.environmentId}'`)}) EXECUTE FUNCTION ${refuse}()`
    )
    try {
      const ack = await ackForReportedOutcome(ctx.db, {
        serverId: ctx.serverId,
        envelope: lateSuccess(record.id),
        record: null,
      })
      assertEquals(ack?.id, record.id)
    } finally {
      await ctx.db.execute(sql`DROP TRIGGER ${refuse} ON deployment`)
      await ctx.db.execute(sql`DROP FUNCTION ${refuse}()`)
    }
    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'succeeded')
    const [row] = await ctx.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.environmentId, ctx.environmentId))
    assertEquals(row?.status, 'failed')
  })
})

test('a late success for a cancelled deploy or another command is confirmed and changes nothing', async () => {
  await withDeployFixtures(async (ctx) => {
    const cancelled = await timedOutDeploy(ctx)
    await ctx.db.update(command).set({ status: 'cancelled' }).where(eq(command.id, cancelled.id))
    const ping = await createCommandRecord(ctx.db, {
      serverId: ctx.serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    await transitionCommand(ctx.db, ping.id, { status: 'timed_out' })
    const running = await createCommandRecord(ctx.db, {
      serverId: ctx.serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'daemon.ping',
      payload: {},
    })
    await transitionCommand(ctx.db, running.id, {
      status: 'sent',
      sentAt: new Date().toISOString(),
    })

    const ackFor = (id: string) =>
      ackForReportedOutcome(ctx.db, {
        serverId: ctx.serverId,
        envelope: lateSuccess(id),
        record: null,
      })
    assertEquals((await ackFor(cancelled.id))?.id, cancelled.id)
    assertEquals((await ackFor(ping.id))?.id, ping.id)
    // Not final and nothing in the cell holds it: kept, so the daemon sends it again.
    assertEquals(await ackFor(running.id), null)

    assertEquals((await getCommandRecord(ctx.db, cancelled.id))?.status, 'cancelled')
    assertEquals((await getCommandRecord(ctx.db, ping.id))?.status, 'timed_out')
    assertEquals((await getCommandRecord(ctx.db, running.id))?.status, 'sent')
  })
})

test('an outcome is confirmed to the daemon only when it is stored and the daemon knows the confirmation', async () => {
  await withConsumerFixtures(async ({ db, serverId }) => {
    await attachConnectedDaemonStatus(db, serverId)
    const record = await createCommandRecord(db, {
      serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'environment.deploy',
      payload: { notAnEnvironmentId: true },
    })
    await transitionCommand(db, record.id, { status: 'sent', sentAt: new Date().toISOString() })
    const envelope = {
      kind: 'command-outcome' as const,
      requestId: record.id,
      at: '2026-10-22T13:46:00.000Z',
      ok: true,
    }
    const stored = ACKED_REQUEST(serverId, record.id)

    // An older daemon is never sent a message it does not know.
    assertEquals(await ackForReportedOutcome(db, { serverId, envelope, record: stored }), null)

    await touchServerMetadata(db, serverId, { features: ['command-recovery-v1'] })
    // The cell holds the result for the consumer: confirmed.
    const ack = await ackForReportedOutcome(db, { serverId, envelope, record: stored })
    assertEquals(ack?.type, 'command-outcome-ack')
    assertEquals(ack?.id, record.id)
    // Nothing holds it yet: not confirmed, so the daemon sends it again. Why
    // is logged once, not on every resend.
    const writes: string[] = []
    const writeStub = stub(Deno.stderr, 'writeSync', (data: Uint8Array) => {
      writes.push(new TextDecoder().decode(data))
      return data.byteLength
    })
    try {
      assertEquals(await ackForReportedOutcome(db, { serverId, envelope, record: null }), null)
      assertEquals(await ackForReportedOutcome(db, { serverId, envelope, record: null }), null)
    } finally {
      writeStub.restore()
    }
    const kept = writes.filter((line) => line.includes(`result for command ${record.id}`))
    assertEquals(kept.length, 1)
    assertEquals(kept[0]?.includes('still sent and no request in the cell is waiting for it'), true)
  })
})

test('a deploy that sends a sign of life is counted as heard from, and the quiet time is not held against it', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 25 * MIN,
      silentMs: 20 * MIN,
      recovery: true,
    })
    await markCommandContactLost(ctx.db, {
      commandId: record.id,
      lastHeardAt: new Date(Date.now() - 20 * MIN).toISOString(),
    })
    assertEquals(typeof (await readProgress(ctx.db, record.id))?.contactLostAt, 'string')

    await noteReportedCommands(ctx.db, ctx.serverId, { running: [record.id], unacked: [] })

    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.progress?.contactLostAt ?? null, null)
    // 25 minutes in, 20 of them silent: about 5 minutes of counted run time remain on the clock.
    const since = Date.parse(stored?.progress?.runningSince ?? '')
    const counted = Date.now() - since
    assertEquals(counted < 10 * MIN, true)
  })
})

test('the next step plan from a quiet server clears the checking mark and gives back the quiet time', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 25 * MIN,
      silentMs: 20 * MIN,
      recovery: true,
    })
    assertEquals(
      await markCommandContactLost(ctx.db, {
        commandId: record.id,
        lastHeardAt: new Date(Date.now() - 20 * MIN).toISOString(),
      }),
      true
    )
    // Marking again changes nothing, and does not reset the silence clock.
    assertEquals(
      await markCommandContactLost(ctx.db, { commandId: record.id, lastHeardAt: 'later' }),
      false
    )

    const stored = await getCommandRecord(ctx.db, record.id)
    const result = await recordCommandProgress(ctx.db, {
      serverId: ctx.serverId,
      commandId: record.id,
      progress: { ...stored!.progress!, updatedAt: new Date().toISOString() },
    })

    assertEquals(result, 'stored')
    const after = await getCommandRecord(ctx.db, record.id)
    assertEquals(after?.progress?.contactLostAt ?? null, null)
    assertEquals(Date.now() - Date.parse(after?.progress?.runningSince ?? '') < 10 * MIN, true)
  })
})

// --- A result survives a lost link and a control plane restart -------------------------------

/**
 * The pending requests a cell keeps outside any one control plane process (Redis or Durable
 * Object storage). A restart is a new registry over the same map.
 */
function survivingCellRequests(serverId: string) {
  const requests = new Map<string, PendingRequestRecord>()
  const process = () => {
    const registry = createDispatchMockRegistry(serverId, { waitForRequestResult: null })
    const base = registry.getCell(serverId)
    const cell: DaemonCell = {
      ...base,
      getRequest: (id) => Promise.resolve(requests.get(id) ?? null),
      handleInbound: (envelope) => {
        if (envelope.kind !== 'command-outcome') return Promise.resolve(null)
        const held = requests.get(envelope.requestId)
        if (held === undefined) return Promise.resolve(null)
        const settled: PendingRequestRecord = {
          ...held,
          status: envelope.ok ? 'done' : 'failed',
          finishedAt: envelope.at,
          ...(envelope.result === undefined ? {} : { result: envelope.result }),
          ...(envelope.error === undefined ? {} : { error: envelope.error }),
        }
        requests.set(envelope.requestId, settled)
        return Promise.resolve(settled)
      },
    }
    return Object.assign(registry, { getCell: () => cell })
  }
  return { requests, process }
}

test('a control plane restart mid-run keeps waiting for the deploy without sending it again', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 14 * MIN,
      silentMs: 7 * MIN,
      recovery: true,
    })
    const cells = survivingCellRequests(ctx.serverId)
    cells.requests.set(record.id, ACKED_REQUEST(ctx.serverId, record.id))
    const { sent, queue } = fakeQueue()

    // The process that sent the deploy died; the queue hands the message to a fresh one.
    const afterRestart = cells.process()
    await processCommandEnvelope(ctx.db, afterRestart, buildEnvelope(record, ctx.serverId), {
      commandQueue: queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
      deployWaitEndMs: 0,
    })

    // Past the old ten minute cap and quiet: still waiting, never sent twice, never failed.
    assertEquals(afterRestart.enqueueCalled, false)
    assertEquals(sent.length, 1)
    const waiting = await getCommandRecord(ctx.db, record.id)
    assertEquals(waiting?.status, 'sent')
    assertEquals(waiting?.error ?? null, null)
    assertEquals(typeof waiting?.progress?.contactLostAt, 'string')
  })
})

test('an outcome the server sends again after a reconnect is confirmed and settles the deploy', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 20 * MIN,
      silentMs: 12 * MIN,
      recovery: true,
    })
    const cells = survivingCellRequests(ctx.serverId)
    cells.requests.set(record.id, ACKED_REQUEST(ctx.serverId, record.id))
    const { sent, queue } = fakeQueue()
    const consumerDeps = {
      commandQueue: queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
      deployWaitEndMs: 0,
    }

    // The link is down: the wait is handed back, the deploy is not failed.
    await processCommandEnvelope(
      ctx.db,
      cells.process(),
      buildEnvelope(record, ctx.serverId),
      consumerDeps
    )
    assertEquals((await getCommandRecord(ctx.db, record.id))?.status, 'sent')

    // The daemon reconnects and sends the result it kept on disk.
    const replies: unknown[] = []
    const linkBack = cells.process()
    const finishedAt = new Date().toISOString()
    await dispatchDaemonInboundMessage({
      cell: linkBack.getCell(),
      db: ctx.db,
      serverId: ctx.serverId,
      connectionId: 'conn-after-reconnect',
      message: {
        type: 'command-outcome',
        id: record.id,
        ok: true,
        result: { containers: [] },
        at: finishedAt,
        daemonRespondedAt: finishedAt,
      },
      reply: (message) => replies.push(message),
    })
    assertEquals(replies.length, 1)
    assertEquals((replies[0] as { type: string }).type, 'command-outcome-ack')
    assertEquals((replies[0] as { id: string }).id, record.id)

    // The handed-back wait picks the stored result up, after a restart or not.
    await processCommandEnvelope(
      ctx.db,
      cells.process(),
      buildEnvelope(record, ctx.serverId),
      consumerDeps
    )
    assertEquals(sent.length, 1)
    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'succeeded')
    assertEquals(stored?.progress?.contactLostAt ?? null, null)
    const [row] = await ctx.db
      .select({ status: deployment.status, applied: deployment.appliedGeneration })
      .from(deployment)
      .where(eq(deployment.serverId, ctx.serverId))
    assertEquals(row?.status, 'applied')
    assertEquals(row?.applied, 2)
  })
})

test('an outcome from a daemon that does not know the confirmation is stored but not confirmed', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 2 * MIN,
      silentMs: 0,
      recovery: false,
    })
    const cells = survivingCellRequests(ctx.serverId)
    cells.requests.set(record.id, ACKED_REQUEST(ctx.serverId, record.id))
    const replies: unknown[] = []
    const at = new Date().toISOString()
    await dispatchDaemonInboundMessage({
      cell: cells.process().getCell(),
      db: ctx.db,
      serverId: ctx.serverId,
      connectionId: 'conn-old-daemon',
      message: { type: 'command-outcome', id: record.id, ok: true, at },
      reply: (message) => replies.push(message),
    })
    assertEquals(replies, [])
    assertEquals(cells.requests.get(record.id)?.status, 'done')
  })
})

// --- The cell's copy of a deploy's request runs out --------------------------------------------

/**
 * Pending requests that expire like the real cells do: a request read after its
 * `expiresAt` is `expired`. Every wait moves this cell's clock on by `stepMs`.
 */
function expiringCellRequests(serverId: string, stepMs: number) {
  const requests = new Map<string, PendingRequestRecord>()
  let offsetMs = 0
  const registry = createDispatchMockRegistry(serverId, { waitForRequestResult: null })
  const base = registry.getCell(serverId)
  const cell: DaemonCell = {
    ...base,
    getRequest: (id) => {
      const held = requests.get(id)
      if (held === undefined) return Promise.resolve(null)
      const expired = Date.now() + offsetMs >= Date.parse(held.expiresAt)
      return Promise.resolve(expired ? { ...held, status: 'expired' as const } : held)
    },
    waitForRequest: () => {
      offsetMs += stepMs
      return Promise.resolve(null)
    },
  }
  return { requests, registry: Object.assign(registry, { getCell: () => cell }) }
}

test('a resumed deploy whose request has expired is given up on, never sent again', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 20 * MIN,
      silentMs: 10 * MIN,
      recovery: true,
    })
    const cells = expiringCellRequests(ctx.serverId, 0)
    cells.requests.set(record.id, {
      ...ACKED_REQUEST(ctx.serverId, record.id),
      expiresAt: new Date(Date.now() - MIN).toISOString(),
    })
    const { sent, queue } = fakeQueue()

    await processCommandEnvelope(ctx.db, cells.registry, buildEnvelope(record, ctx.serverId), {
      commandQueue: queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
      deployWaitEndMs: 0,
    })

    assertEquals(cells.registry.enqueueCalled, false)
    assertEquals(sent.length, 0)
    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'timed_out')
    assertEquals(stored?.error?.includes('Lost contact with the server'), true)
    assertEquals(stored?.error?.includes('Last known step: Build running'), true)
    const [row] = await ctx.db
      .select({ status: deployment.status })
      .from(deployment)
      .where(eq(deployment.serverId, ctx.serverId))
    assertEquals(row?.status, 'failed')
  })
})

test('a deploy whose request expires during the wait ends with the lost-contact message', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 20 * MIN,
      silentMs: 0,
      recovery: true,
    })
    // Still held when the wait is picked up; gone by the first poll.
    const cells = expiringCellRequests(ctx.serverId, 2 * MIN)
    cells.requests.set(record.id, {
      ...ACKED_REQUEST(ctx.serverId, record.id),
      expiresAt: new Date(Date.now() + MIN).toISOString(),
    })
    const { sent, queue } = fakeQueue()

    await processCommandEnvelope(ctx.db, cells.registry, buildEnvelope(record, ctx.serverId), {
      commandQueue: queue,
      firewallApplyGate: DENY_FIREWALL_APPLY,
    })

    assertEquals(cells.registry.enqueueCalled, false)
    assertEquals(sent.length, 0)
    const stored = await getCommandRecord(ctx.db, record.id)
    assertEquals(stored?.status, 'timed_out')
    assertEquals(stored?.error?.includes('Lost contact with the server'), true)
  })
})

test('a late success for a deploy a newer one replaced changes nothing the newer deploy owns', async () => {
  await withDeployFixtures(async (ctx) => {
    const record = await quietDeploy({
      ctx,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ranMs: 7 * 60 * MIN,
      silentMs: 7 * 60 * MIN,
      recovery: true,
    })
    const registry = registryWithRequest(ctx.serverId, (id) => ACKED_REQUEST(ctx.serverId, id))
    await processCommandEnvelope(ctx.db, registry, buildEnvelope(record, ctx.serverId), {
      firewallApplyGate: DENY_FIREWALL_APPLY,
      deployWaitHoldMs: 0,
    })
    assertEquals((await getCommandRecord(ctx.db, record.id))?.status, 'timed_out')

    // A newer deploy now owns the server's deployment row and its container.
    const newer = await createCommandRecord(ctx.db, {
      serverId: ctx.serverId,
      ...TEST_COMMAND_ACTOR,
      type: 'environment.deploy',
      payload: { notAnEnvironmentId: true },
    })
    await ctx.db
      .update(deployment)
      .set({
        lastCommandId: newer.id,
        desiredGeneration: 3,
        status: 'applied',
        appliedGeneration: 3,
      })
      .where(eq(deployment.serverId, ctx.serverId))
    await ctx.db.insert(container).values({
      serviceId: ctx.webServiceId,
      serverId: ctx.serverId,
      containerId: 'newer-cid',
      containerName: 'tp-deploy-test-web-1',
      status: 'running',
      composeServiceName: 'web',
      ordinal: 1,
    })

    assertEquals(
      await settleReportedOutcome(ctx.db, {
        serverId: ctx.serverId,
        envelope: {
          kind: 'command-outcome',
          requestId: record.id,
          at: new Date().toISOString(),
          ok: true,
          result: { containers: [] },
        },
        record: null,
      }),
      true
    )

    assertEquals((await getCommandRecord(ctx.db, record.id))?.status, 'succeeded')
    const [row] = await ctx.db
      .select({
        status: deployment.status,
        applied: deployment.appliedGeneration,
        last: deployment.lastCommandId,
      })
      .from(deployment)
      .where(eq(deployment.serverId, ctx.serverId))
    assertEquals(row, { status: 'applied', applied: 3, last: newer.id })
    const containers = await ctx.db
      .select({ containerId: container.containerId, status: container.status })
      .from(container)
      .where(eq(container.serverId, ctx.serverId))
    assertEquals(containers, [{ containerId: 'newer-cid', status: 'running' }])
  })
})
