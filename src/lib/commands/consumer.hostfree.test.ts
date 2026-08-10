/**
 * Host-free coverage for pure consumer helpers + early processCommandEnvelope
 * paths (no Postgres / Redis).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import type {
  DaemonCell,
  DaemonCellRegistry,
  PendingRequestRecord,
} from '../../daemon/cell/contracts.ts'
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
  assertEquals(commandTimeoutMs('server.wireguard.apply'), 300_000)
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
  assertEquals(commandTimeoutMs('system.reconcile'), 300_000)
  assertEquals(commandTimeoutMs('unknown.future.command'), 60_000)
})

test('extractObservedHostname parses valid results and swallows invalid', () => {
  assertEquals(
    extractObservedHostname({ observedHostname: 'web-01' }),
    'web-01',
  )
  assertEquals(extractObservedHostname(null), null)
  assertEquals(extractObservedHostname({}), null)
  assertEquals(extractObservedHostname({ observedHostname: '' }), null)
})

test('enrichPingResult only attaches cellDispatchedAt for daemon.ping', () => {
  assertEquals(
    enrichPingResult('server.reboot', { scheduled: true }, {
      sentAt: '2020-01-01T00:00:00.000Z',
    }),
    { scheduled: true },
  )
  assertEquals(
    enrichPingResult('daemon.ping', { daemonHostname: 'h' }, {}),
    { daemonHostname: 'h' },
  )
  assertEquals(
    enrichPingResult(
      'daemon.ping',
      { daemonHostname: 'h' },
      { sentAt: '2020-01-01T00:00:05.000Z' },
    ),
    {
      daemonHostname: 'h',
      cellDispatchedAt: '2020-01-01T00:00:05.000Z',
    },
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
  assertEquals(
    hasManagedFollowUpDeps({ commandQueue: createNoopCommandQueue() }),
    false,
  )
  const liveQueue = {
    enqueue: async () => {},
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
    true,
  )
})

test('resolveManagedIdFromPayload extracts ids and returns null on miss', () => {
  assertEquals(
    resolveManagedIdFromPayload('managed.lifecycle', {
      managedId: MANAGED_ID,
      action: 'start',
    }),
    MANAGED_ID,
  )
  assertEquals(
    resolveManagedIdFromPayload('managed.destroy', {
      managedId: MANAGED_ID,
      removeVolumes: true,
    }),
    MANAGED_ID,
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
  payload: unknown
  result: unknown
  metadata: Record<string, unknown> | null
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
    payload: {},
    result: null,
    metadata: { queuedAt: '2020-01-01T00:00:00.000Z' },
    ...overrides,
  }
}

type ConsumerFakeDbOptions = Readonly<{
  commandRow?: CommandRow | null
  serverExists?: boolean
  serverConnected?: boolean
}>

function createConsumerFakeDb(options: ConsumerFakeDbOptions = {}): {
  db: Db
  transitions: Array<{ status: string; error?: string }>
} {
  const transitions: Array<{ status: string; error?: string }> = []
  const commandRow = options.commandRow === undefined
    ? baseCommandRow()
    : options.commandRow
  const serverExists = options.serverExists ?? true
  const serverConnected = options.serverConnected ?? false

  const db = {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          // getCommandRecord: select() with no field map
          if (fields === undefined) {
            return queryResult(commandRow ? [commandRow] : [])
          }
          // getServerLicenseBinding first hop
          if ('organizationId' in fields && !('id' in fields)) {
            return queryResult(
              serverExists
                ? [{ organizationId: '00000000-0000-4000-8000-000000000099' }]
                : [],
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
                ? [{
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
                }]
                : [],
            )
          }
          return queryResult([])
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        if (typeof patch.status === 'string') {
          transitions.push({
            status: patch.status,
            ...(typeof patch.error === 'string' ? { error: patch.error } : {}),
          })
        }
        // transitionCommand merges metadata via sql`…` — tolerate any shape.
        const meta = patch.metadata
        if (
          meta &&
          typeof meta === 'object' &&
          'error' in (meta as object) &&
          typeof (meta as { error?: unknown }).error === 'string'
        ) {
          const last = transitions[transitions.length - 1]
          if (last) last.error = (meta as { error: string }).error
        }
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([
                commandRow
                  ? {
                    ...commandRow,
                    status: (patch.status as string) ?? commandRow.status,
                    updatedAt: new Date().toISOString(),
                    metadata: {
                      ...(commandRow.metadata ?? {}),
                      ...(typeof patch.error === 'string'
                        ? { error: patch.error }
                        : {}),
                    },
                    ...(patch.result !== undefined
                      ? { result: patch.result }
                      : {}),
                    ...(typeof patch.attempts === 'number'
                      ? { attempts: patch.attempts }
                      : {}),
                  }
                  : undefined,
              ].filter(Boolean)),
          }),
        }
      },
    }),
  } as unknown as Db

  return { db, transitions }
}

function emptyRegistry(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new TypeError('getCell must not be called on fail-fast paths')
    },
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
    purge: async () => {},
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
    commandRow: baseCommandRow({
      metadata: {
        queuedAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:00:01.000Z',
      },
    }),
  })
  await processCommandEnvelope(db, emptyRegistry(), {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })
  assertEquals(transitions.some((t) => t.status === 'timed_out'), true)
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
  assertEquals(transitions.some((t) => t.status === 'dispatching'), true)
  assertEquals(transitions.some((t) => t.status === 'failed'), true)
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
  assertEquals(transitions.some((t) => t.status === 'dispatching'), true)
  assertEquals(transitions.some((t) => t.status === 'failed'), true)
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
    attachDaemonSocket: async () => ({
      connectionId: 'conn',
      lease: {
        holder: 'conn',
        expiresAt: '2020-01-01T00:01:00.000Z',
      },
    }),
    detachDaemonSocket: async () => {},
    recordInbound: async () => {},
    getSnapshot: async () => ({
      serverId: SERVER_ID,
      version: 1,
      updatedAt: '2020-01-01T00:00:00.000Z',
      connected: true,
    }),
    putSnapshot: async (patch) => ({
      serverId: SERVER_ID,
      version: 1,
      updatedAt: '2020-01-01T00:00:00.000Z',
      connected: true,
      ...patch,
    }),
    enqueue: async (outbound) => ({
      serverId: SERVER_ID,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'queued',
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    markSent: async () => {},
    handleInbound: async () => null,
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => pending,
    createRequestAndWait: async (outbound) => ({
      serverId: SERVER_ID,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'done',
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    readOutboxBatch: async () => [],
    ackOutbox: async () => {},
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: async () => {},
    prune: async () => [],
    clearUpdateStatus: async () => ({ cleared: 0 }),
    purge: async () => {},
  }

  const registry: DaemonCellRegistry = {
    getCell: () => cell,
    listOnlineServerIds: async () => [SERVER_ID],
    getSnapshots: async () => new Map(),
    purge: async () => {},
  }

  await processCommandEnvelope(db, registry, {
    commandId: COMMAND_ID,
    serverId: SERVER_ID,
    type: 'daemon.ping',
    attempt: 1,
    queuedAt: '2020-01-01T00:00:00.000Z',
  })

  assertEquals(transitions.some((t) => t.status === 'dispatching'), true)
  assertEquals(transitions.some((t) => t.status === 'sent'), true)
  assertEquals(transitions.some((t) => t.status === 'succeeded'), true)
})
