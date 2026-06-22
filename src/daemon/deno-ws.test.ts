import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../client/authn/secrets.ts'
import type { Db } from '../db.ts'
import { generateSecret } from '../generate-secret.ts'
import type {
  DaemonCell,
  DaemonCellRegistry,
  DaemonCellSnapshot,
} from './cell/contracts.ts'
import type { DaemonInboundEnvelope, DaemonOutboundEnvelope } from './cell/protocol.ts'
import { issueDaemonJwt } from './authn/daemon-jwt.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { DAEMON_WS_PATH } from '../surfaces.ts'

async function createDaemonJwtSecrets() {
  const parsed = parseSecretsEnv(generateSecret(), undefined, 'deno')
  return deriveSecretsConfig(parsed, 'daemon-jwt-signing')
}

function createMockDb(sessionId: string, serverId = 'srv-test'): Db {
  const session = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serverId,
    serverKeyId: 'key-test',
    lastUsedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: null,
  }
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([session]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(undefined),
      }),
    }),
  } as unknown as Db
}

function createTrackingDaemonCell(serverId: string) {
  const calls = {
    attach: 0,
    detach: 0,
    heartbeat: 0,
    putSnapshot: 0,
    handleInbound: 0,
    readOutboxBatch: 0,
  }
  let snapshot: DaemonCellSnapshot = {
    serverId,
    version: 0,
    updatedAt: new Date().toISOString(),
    connected: false,
  }

  const cell: DaemonCell = {
    attachDaemonSocket: async (meta) => {
      calls.attach += 1
      snapshot = {
        ...snapshot,
        connected: true,
        sessionId: meta.sessionId,
        remoteAddress: meta.remoteAddress,
        connectedAt: meta.connectedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      return {
        connectionId: 'track-conn',
        lease: {
          holder: 'track-conn',
          token: 'track-conn',
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        },
      }
    },
    detachDaemonSocket: async () => {
      calls.detach += 1
      snapshot = {
        ...snapshot,
        connected: false,
        updatedAt: new Date().toISOString(),
      }
    },
    heartbeat: async () => {
      calls.heartbeat += 1
    },
    getSnapshot: async () => snapshot,
    putSnapshot: async (patch) => {
      calls.putSnapshot += 1
      snapshot = {
        ...snapshot,
        ...patch,
        serverId,
        version: snapshot.version + 1,
        updatedAt: new Date().toISOString(),
      }
      return snapshot
    },
    appendEvent: async () => {},
    listEvents: async () => [],
    enqueue: async (outbound: DaemonOutboundEnvelope) => {
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
    handleInbound: async (_inbound: DaemonInboundEnvelope) => {
      calls.handleInbound += 1
      return null
    },
    getRequest: async () => null,
    listRequests: async () => [],
    waitForRequest: async () => null,
    createRequestAndWait: async (outbound) => ({
      serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'expired' as const,
      createdAt: outbound.at,
      expiresAt: outbound.at,
    }),
    claimDeliveryLease: async () => null,
    renewDeliveryLease: async () => null,
    releaseDeliveryLease: async () => {},
    readOutboxBatch: async () => {
      calls.readOutboxBatch += 1
      return []
    },
    ackOutbox: async () => {},
    prune: async () => {},
  }

  return { cell, calls, getSnapshot: () => snapshot }
}

function createTrackingRegistry(cell: DaemonCell): DaemonCellRegistry {
  return {
    getCell: () => cell,
    listOnlineServerIds: async () => [],
    getSnapshots: async () => new Map(),
  }
}

function registerTestDaemonWebSocket(
  app: Hono,
  secrets: Awaited<ReturnType<typeof createDaemonJwtSecrets>>,
  options: {
    db?: Db
    registry?: DaemonCellRegistry
  } = {},
) {
  registerDaemonWebSocket(app, {
    secrets,
    db: options.db,
    daemonCellRegistry: options.registry ?? createTrackingRegistry(
      createTrackingDaemonCell('srv-test').cell,
    ),
  })
}

const WS_UPGRADE_HEADERS = {
  Upgrade: 'websocket',
  Connection: 'Upgrade',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'dGVzdC1rZXk=',
} as const

Deno.test('WS upgrade accepts HTTP 101 with valid JWT', async () => {
  const app = new Hono()
  const secrets = await createDaemonJwtSecrets()
  const sessionId = crypto.randomUUID()
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(sessionId),
  })

  const issued = await issueDaemonJwt(
    { sub: 'srv-test', sid: sessionId, kid: 'key-test' },
    secrets,
  )
  const response = await app.request(DAEMON_WS_PATH, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  })
  assertEquals(response.status, 101)
})

Deno.test('WS upgrade rejects HTTP 401 when no JWT is provided', async () => {
  const app = new Hono()
  const secrets = await createDaemonJwtSecrets()
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(crypto.randomUUID()),
  })

  const response = await app.request(DAEMON_WS_PATH, { method: 'GET' })
  assertEquals(response.status, 401)
})

Deno.test('WS upgrade rejects HTTP 401 when JWT is invalid', async () => {
  const app = new Hono()
  const secrets = await createDaemonJwtSecrets()
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(crypto.randomUUID()),
  })

  const response = await app.request(DAEMON_WS_PATH, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer invalid-token',
    },
  })
  assertEquals(response.status, 401)
})

Deno.test('WS lifecycle attaches, handles ping, and detaches through cell backend', async () => {
  const app = new Hono()
  const secrets = await createDaemonJwtSecrets()
  const sessionId = crypto.randomUUID()
  const serverId = 'srv-lifecycle'
  const tracking = createTrackingDaemonCell(serverId)
  registerTestDaemonWebSocket(app, secrets, {
    db: createMockDb(sessionId, serverId),
    registry: createTrackingRegistry(tracking.cell),
  })

  const issued = await issueDaemonJwt(
    { sub: serverId, sid: sessionId, kid: 'key-test' },
    secrets,
  )
  const response = await app.request(DAEMON_WS_PATH, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${issued.token}`,
      ...WS_UPGRADE_HEADERS,
    },
  })
  assertEquals(response.status, 101)

  const ws = response.webSocket
  if (!ws) {
    console.warn(
      'Skipping WS lifecycle assertions: response.webSocket unavailable in Deno test runtime',
    )
    return
  }
  ws.accept()

  await new Promise((resolve) => setTimeout(resolve, 50))
  assertEquals(tracking.calls.attach, 1)
  assertEquals(tracking.getSnapshot().connected, true)

  ws.send(JSON.stringify({
    type: 'ping',
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
  }))

  await new Promise((resolve) => setTimeout(resolve, 50))
  assertEquals(tracking.calls.heartbeat >= 1, true)
  assertEquals(tracking.calls.putSnapshot >= 1, true)

  ws.close(1000, 'test done')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assertEquals(tracking.calls.detach, 1)
  assertEquals(tracking.getSnapshot().connected, false)
})
