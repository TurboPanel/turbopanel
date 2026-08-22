/**
 * Host-free coverage for pure consumer helpers + early processCommandEnvelope
 * paths (no Postgres / Redis).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import type {
  DaemonCell,
  DaemonCellRegistry,
  PendingRequestRecord,
} from '../../daemon/cell/contracts.ts'
import { COMMAND_DISPATCH_FAILURE_RETENTION_MS } from '../db/command-records.ts'
import type { CommandEnvelope } from './envelope.ts'
import {
  commandTimeoutMs,
  enrichPingResult,
  errorMessage,
  extractObservedHostname,
  hasManagedFollowUpDeps,
  isManagedObservedStatus,
  isPostgresUniqueViolation,
  isTransientError,
  processCommandEnvelope,
  resolveManagedIdFromPayload,
} from './consumer.ts'
import { createNoopCommandQueue } from './noop-command-queue.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const MANAGED_ID = '00000000-0000-4000-8000-0000000000aa'
const SERVER_ID = '00000000-0000-4000-8000-0000000000bb'
const COMMAND_ID = '00000000-0000-4000-8000-0000000000cc'

test('commandTimeoutMs returns per-type budgets and the default', () => {
  assertEquals(commandTimeoutMs('daemon.ping'), 30_000)
  assertEquals(commandTimeoutMs('server.hostname.set'), 120_000)
  assertEquals(commandTimeoutMs('server.ntp.set'), 300_000)
  assertEquals(commandTimeoutMs('server.timezone.set'), 300_000)
  assertEquals(commandTimeoutMs('server.reboot'), 120_000)
  assertEquals(commandTimeoutMs('server.fabric.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('server.tls.trust.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('environment.deploy'), 600_000)
  assertEquals(commandTimeoutMs('environment.lifecycle'), 120_000)
  assertEquals(commandTimeoutMs('environment.stop'), 120_000)
  assertEquals(commandTimeoutMs('managed.apply'), 600_000)
  assertEquals(commandTimeoutMs('managed.lifecycle'), 120_000)
  assertEquals(commandTimeoutMs('managed.destroy'), 300_000)
  assertEquals(commandTimeoutMs('managed.backup'), 1_800_000)
  assertEquals(commandTimeoutMs('managed.restore'), 1_800_000)
  assertEquals(commandTimeoutMs('managed.promote'), 600_000)
  assertEquals(commandTimeoutMs('managed.ingress.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('managed.ha.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('managed.ha.failover'), 600_000)
  assertEquals(commandTimeoutMs('system.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('unknown.future.command'), 60_000)
})

test('extractObservedHostname parses valid results and swallows invalid', () => {
  assertEquals(extractObservedHostname({ observedHostname: 'web-01' }), 'web-01')
  assertEquals(extractObservedHostname(null), null)
  assertEquals(extractObservedHostname({}), null)
  assertEquals(extractObservedHostname({ observedHostname: '' }), null)
})

test('enrichPingResult only attaches cellDispatchedAt for daemon.ping', () => {
  assertEquals(
    enrichPingResult(
      'server.reboot',
      { scheduled: true },
      {
        sentAt: '2020-01-01T00:00:00.000Z',
      }
    ),
    { scheduled: true }
  )
  assertEquals(enrichPingResult('daemon.ping', { daemonHostname: 'h' }, {}), {
    daemonHostname: 'h',
  })
  assertEquals(
    enrichPingResult(
      'daemon.ping',
      { daemonHostname: 'h' },
      { sentAt: '2020-01-01T00:00:05.000Z' }
    ),
    {
      daemonHostname: 'h',
      cellDispatchedAt: '2020-01-01T00:00:05.000Z',
    }
  )
})

test('errorMessage prefers Error.message then String()', () => {
  assertEquals(errorMessage(new Error('boom')), 'boom')
  assertEquals(errorMessage('plain'), 'plain')
  assertEquals(errorMessage(42), '42')
})

test('isPostgresUniqueViolation detects Postgres 23505 only', () => {
  assertEquals(isPostgresUniqueViolation({ code: '23505' }), true)
  assertEquals(isPostgresUniqueViolation({ code: '23503' }), false)
  assertEquals(isPostgresUniqueViolation(null), false)
  assertEquals(isPostgresUniqueViolation('23505'), false)
})

test('isManagedObservedStatus accepts projectable statuses only', () => {
  assertEquals(isManagedObservedStatus('ready'), true)
  assertEquals(isManagedObservedStatus('stopped'), true)
  assertEquals(isManagedObservedStatus('failed'), true)
  assertEquals(isManagedObservedStatus('applying'), false)
  assertEquals(isManagedObservedStatus('provisioning'), false)
})

test('hasManagedFollowUpDeps requires live queue plus both secret configs', () => {
  assertEquals(hasManagedFollowUpDeps(undefined), false)
  assertEquals(hasManagedFollowUpDeps({}), false)
  assertEquals(hasManagedFollowUpDeps({ commandQueue: createNoopCommandQueue() }), false)
  const liveQueue = {
    enqueue: () => Promise.resolve(),
  }
  assertEquals(
    hasManagedFollowUpDeps({
      commandQueue: liveQueue,
      secretsConfig: { versioned: [] } as never,
      dataEncryptionSecrets: {
        current: { version: 1, key: {} as CryptoKey },
        fallbacks: [],
      },
    }),
    true
  )
})

test('resolveManagedIdFromPayload extracts ids and returns null on miss', () => {
  assertEquals(
    resolveManagedIdFromPayload('managed.lifecycle', {
      managedId: MANAGED_ID,
      action: 'start',
    }),
    MANAGED_ID
  )
  assertEquals(
    resolveManagedIdFromPayload('managed.destroy', {
      managedId: MANAGED_ID,
      removeVolumes: true,
    }),
    MANAGED_ID
  )
  assertEquals(resolveManagedIdFromPayload('managed.lifecycle', {}), null)
  assertEquals(resolveManagedIdFromPayload('managed.apply', { managedId: 'x' }), null)
  assertEquals(resolveManagedIdFromPayload('daemon.ping', {}), null)
})

test('isTransientError still classifies durable-object / overloaded edges', () => {
  assertEquals(isTransientError(new Error('Durable Object unavailable')), true)
  assertEquals(isTransientError(new Error('queue overloaded')), false)
})

function queryResult<T>(rows: T[]) {
  const promise = Promise.resolve(rows)
  return Object.assign(promise, {
    limit: (_n: number) => Promise.resolve(rows),
    orderBy: (..._cols: unknown[]) =>
      Object.assign(Promise.resolve(rows), {
        limit: (_n: number) => Promise.resolve(rows),
      }),
  })
}

type CommandRow = {
  id: string
  createdAt: string
  updatedAt: string
  serverId: string
  actorType: string
  actorId: string
  name: string
  status: string
  attempts: number
  context: unknown
  resultSummary: unknown
  errorCode: string | null
  errorMessage: string | null
  queuedAt: string | null
  dispatchStartedAt: string | null
  sentAt: string | null
  ackedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  expiresAt: string | null
}

function baseCommandRow(overrides: Partial<CommandRow> = {}): CommandRow {
  return {
    id: COMMAND_ID,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    serverId: SERVER_ID,
    actorType: 'user',
    actorId: '00000000-0000-4000-8000-000000000001',
    name: 'daemon.ping',
    status: 'queued',
    attempts: 0,
    context: null,
    resultSummary: null,
    errorCode: null,
    errorMessage: null,
    queuedAt: '2020-01-01T00:00:00.000Z',
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

type ConsumerFakeDbOptions = Readonly<{
  commandRow?: CommandRow | null
  serverExists?: boolean
  serverConnected?: boolean
  /** `null` simulates a dispatch payload that is already cleaned up. */
  dispatchPayload?: unknown
}>

function createConsumerFakeDb(options: ConsumerFakeDbOptions = {}): {
  db: Db
  transitions: Array<{ status: string; error?: string }>
  dispatchDeletes: number
  dispatchRetentions: string[]
} {
  const transitions: Array<{ status: string; error?: string }> = []
  const dispatchState = { deletes: 0, retentions: [] as string[] }
  const dispatchPayload =
    options.dispatchPayload === undefined ? {} : options.dispatchPayload
  const commandRow = options.commandRow === undefined ? baseCommandRow() : options.commandRow
  const serverExists = options.serverExists ?? true
  const serverConnected = options.serverConnected ?? false

  const db = {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          // getCommandRecord / listServerCommands: explicit command columns
          if (fields && 'name' in fields && 'attempts' in fields) {
            return queryResult(commandRow ? [commandRow] : [])
          }
          // getCommandDispatchPayload
          if (fields && 'payload' in fields) {
            return queryResult(
              dispatchPayload === null ? [] : [{ payload: dispatchPayload }],
            )
          }
          if (fields === undefined) {
            return queryResult(commandRow ? [commandRow] : [])
          }
          // getServerLicenseBinding first hop
          if ('organizationId' in fields && !('id' in fields)) {
            return queryResult(
              serverExists ? [{ organizationId: '00000000-0000-4000-8000-000000000099' }] : []
            )
          }
          // getServerLicenseBinding license hops
          if ('id' in fields && !('daemon' in fields) && !('metadata' in fields)) {
            return queryResult([{ id: 'license-1' }])
          }
          // resolveFleetPresence
          if ('daemon' in fields || 'connected' in fields) {
            return queryResult(
              serverExists
                ? [
                    {
                      id: SERVER_ID,
                      daemon: {
                        key: {
                          id: 'key-1',
                          algorithm: 'Ed25519',
                          publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
                          fingerprint: 'fp',
                          createdAt: '2020-01-01T00:00:00.000Z',
                        },
                      },
                      metadata: null,
                      hostname: 'host-1',
                      machineKey: null,
                      connected: serverConnected,
                      statusChangedAt: '2020-01-01T00:00:00.000Z',
                    },
                  ]
                : []
            )
          }
          return queryResult([])
        },
      }),
    }),
    delete: () => ({
      where: () => {
        dispatchState.deletes += 1
        return Promise.resolve(undefined)
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        if (typeof patch.status === 'string') {
          transitions.push({
            status: patch.status,
            ...(typeof patch.errorMessage === 'string'
              ? { error: patch.errorMessage }
              : {}),
          })
        } else if (typeof patch.expiresAt === 'string') {
          // retainCommandDispatch — failure-retention stamp.
          dispatchState.retentions.push(patch.expiresAt)
        }
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(
                [
                  commandRow
                    ? {
                        ...commandRow,
                        status: (patch.status as string) ?? commandRow.status,
                        updatedAt: new Date().toISOString(),
                        ...(typeof patch.errorMessage === 'string'
                          ? { errorMessage: patch.errorMessage }
                          : {}),
                        ...(patch.resultSummary !== undefined
                          ? { resultSummary: patch.resultSummary }
                          : {}),
                        ...(typeof patch.attempts === 'number' ? { attempts: patch.attempts } : {}),
                      }
                    : undefined,
                ].filter(Boolean)
              ),
          }),
        }
      },
    }),
  } as unknown as Db

  return {
    db,
    transitions,
    get dispatchDeletes() {
      return dispatchState.deletes
    },
    get dispatchRetentions() {
      return dispatchState.retentions
    },
  }
}

function emptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new TypeError('getCell must not be called on fail-fast paths')
    },
    listOnlineServerIds: () => Promise.resolve([]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }
}

test('processCommandEnvelope no-ops when the command row is missing', async () => {
  const { db, transitions } = createConsumerFakeDb({ commandRow: null })
  const envelope: CommandEnvelope = {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  }
  await processCommandEnvelope(db, emptyRegistry(), envelope)
  assertEquals(transitions.length, 0)
})

test('processCommandEnvelope no-ops for already-terminal commands', async () => {
  const { db, transitions } = createConsumerFakeDb({
    commandRow: baseCommandRow({ status: 'succeeded' }),
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(transitions.length, 0)
})

test('processCommandEnvelope marks expired commands timed_out', async () => {
  const { db, transitions } = createConsumerFakeDb({
    commandRow: baseCommandRow({ expiresAt: '2020-01-01T00:00:01.000Z' }),
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(
    transitions.some((t) => t.status === 'timed_out'),
    true
  )
})

test('processCommandEnvelope no-ops on serverId envelope mismatch', async () => {
  const { db, transitions } = createConsumerFakeDb({
    commandRow: baseCommandRow({ serverId: SERVER_ID }),
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: '00000000-0000-4000-8000-0000000000ff',
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(transitions.length, 0)
})

test('processCommandEnvelope fails when the server row is missing', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: false,
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'failed'),
    true
  )
})

test('processCommandEnvelope fails fast when the daemon is offline', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: true,
    serverConnected: false,
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'failed'),
    true
  )
})

function onlineRegistry(pending: PendingRequestRecord | null): {
  registry: DaemonCellRegistry
  enqueued: Array<{ commandId: string; payload: unknown }>
} {
  const enqueued: Array<{ commandId: string; payload: unknown }> = []
  const cell: DaemonCell = {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          expiresAt: '2020-01-01T00:01:00.000Z',
        },
      }),
    detachDaemonSocket: () => Promise.resolve(),
    recordInbound: () => Promise.resolve(),
    getSnapshot: () =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
        ...patch,
      }),
    enqueue: (outbound) => {
      enqueued.push({
        commandId: (outbound as { commandId: string }).commandId,
        payload: (outbound as { payload: unknown }).payload,
      })
      return Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      })
    },
    markSent: () => Promise.resolve(),
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(pending),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: () => Promise.resolve(),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => Promise.resolve(),
  }

  return {
    registry: {
      getCell: () => cell,
      listOnlineServerIds: () => Promise.resolve([SERVER_ID]),
      getSnapshots: () => Promise.resolve(new Map()),
      purge: () => Promise.resolve(),
    },
    enqueued,
  }
}

function donePending(): PendingRequestRecord {
  return {
    serverId: SERVER_ID,
    requestId: COMMAND_ID,
    requestKind: 'command-dispatch',
    status: 'done',
    createdAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-01T00:10:00.000Z',
    sentAt: '2020-01-01T00:00:01.000Z',
    result: { daemonHostname: 'edge-1' },
  }
}

const pingEnvelope: CommandEnvelope = {
  commandId: COMMAND_ID,
  serverId: SERVER_ID,
  type: 'daemon.ping',
  attempt: 1,
  queuedAt: '2020-01-01T00:00:00.000Z',
}

test('processCommandEnvelope dispatches the dispatch payload and drops it on success', async () => {
  const fake = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
    dispatchPayload: { ping: true },
  })
  const { db, transitions } = fake
  const { registry, enqueued } = onlineRegistry(donePending())

  await processCommandEnvelope(db, registry, pingEnvelope)

  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'sent'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'succeeded'),
    true
  )
  // The daemon envelope carries the `dispatch` payload verbatim.
  assertEquals(enqueued.length, 1)
  assertEquals(enqueued[0]?.payload, { ping: true })
  // Success deletes the payload immediately; nothing is retained.
  assertEquals(fake.dispatchDeletes, 1)
  assertEquals(fake.dispatchRetentions.length, 0)
})

test('processCommandEnvelope retains the dispatch payload ~24h after a failure', async () => {
  const fake = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
    dispatchPayload: { ping: true },
  })
  const { db, transitions } = fake
  const { registry } = onlineRegistry({
    ...donePending(),
    status: 'failed',
    error: 'daemon exploded',
    result: undefined,
  })

  await processCommandEnvelope(db, registry, pingEnvelope)

  assertEquals(
    transitions.some((t) => t.status === 'failed' && t.error === 'daemon exploded'),
    true
  )
  assertEquals(fake.dispatchDeletes, 0)
  assertEquals(fake.dispatchRetentions.length, 1)
  const retainedMs = Date.parse(fake.dispatchRetentions[0]!)
  const expectedMs = Date.now() + COMMAND_DISPATCH_FAILURE_RETENTION_MS
  assertEquals(Math.abs(retainedMs - expectedMs) < 60_000, true)
})

test('processCommandEnvelope fails cleanly when the dispatch payload is gone', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
    dispatchPayload: null,
  })
  const { registry, enqueued } = onlineRegistry(donePending())

  await processCommandEnvelope(db, registry, pingEnvelope)

  // Never dispatched an empty envelope; the command failed instead.
  assertEquals(enqueued.length, 0)
  assertEquals(
    transitions.some(
      (t) => t.status === 'failed' && t.error === 'Command dispatch payload unavailable',
    ),
    true
  )
})

test('processCommandEnvelope dispatches when online and maps a done outcome', async () => {
  const { db, transitions } = createConsumerFakeDb({
    serverExists: true,
    serverConnected: true,
  })

  const pending: PendingRequestRecord = {
    serverId: SERVER_ID,
    requestId: COMMAND_ID,
    requestKind: 'command-dispatch',
    status: 'done',
    createdAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-01T00:10:00.000Z',
    sentAt: '2020-01-01T00:00:01.000Z',
    result: { daemonHostname: 'edge-1' },
  }

  const cell: DaemonCell = {
    attachDaemonSocket: () =>
      Promise.resolve({
        connectionId: 'conn',
        lease: {
          holder: 'conn',
          expiresAt: '2020-01-01T00:01:00.000Z',
        },
      }),
    detachDaemonSocket: () => Promise.resolve(),
    recordInbound: () => Promise.resolve(),
    getSnapshot: () =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
      }),
    putSnapshot: (patch) =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: '2020-01-01T00:00:00.000Z',
        connected: true,
        ...patch,
      }),
    enqueue: (outbound) =>
      Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'queued',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    markSent: () => Promise.resolve(),
    handleInbound: () => Promise.resolve(null),
    getRequest: () => Promise.resolve(null),
    listRequests: () => Promise.resolve([]),
    waitForRequest: () => Promise.resolve(pending),
    createRequestAndWait: (outbound) =>
      Promise.resolve({
        serverId: SERVER_ID,
        requestId: outbound.requestId,
        requestKind: outbound.kind,
        status: 'done',
        createdAt: outbound.at,
        expiresAt: outbound.at,
      }),
    readOutboxBatch: () => Promise.resolve([]),
    ackOutbox: () => Promise.resolve(),
    claimDeliveryLease: () => Promise.resolve(null),
    renewDeliveryLease: () => Promise.resolve(null),
    releaseDeliveryLease: () => Promise.resolve(),
    prune: () => Promise.resolve([]),
    clearUpdateStatus: () => Promise.resolve({ cleared: 0 }),
    purge: () => Promise.resolve(),
  }

  const registry: DaemonCellRegistry = {
    getCell: () => cell,
    listOnlineServerIds: () => Promise.resolve([SERVER_ID]),
    getSnapshots: () => Promise.resolve(new Map()),
    purge: () => Promise.resolve(),
  }

  await processCommandEnvelope(db, registry, {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })

  assertEquals(
    transitions.some((t) => t.status === 'dispatching'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'sent'),
    true
  )
  assertEquals(
    transitions.some((t) => t.status === 'succeeded'),
    true
  )
})
