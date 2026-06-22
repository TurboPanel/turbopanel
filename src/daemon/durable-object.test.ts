/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../client/authn/secrets.ts'
import { issueDaemonJwt } from './authn/daemon-jwt.ts'
import {
  generateDeliveryId,
  generateRequestId,
} from './cell/protocol.ts'

const CELL_HEADER = 'X-Turbopanel-Cell-Server-Id'

function decodeJwtJti(token: string): string {
  const [, encodedPayload] = token.split('.')
  const padded = encodedPayload + '='.repeat((4 - (encodedPayload.length % 4)) % 4)
  const base64 = padded.replaceAll('-', '+').replaceAll('_', '/')
  const payload = JSON.parse(atob(base64)) as { jti: string }
  return payload.jti
}

async function issueTestDaemonJwt(
  serverId: string,
  keyId: string,
): Promise<string> {
  const secret = env.TURBOPANEL_SECRET ?? 'aa_daemon_cell_vitest_secret_value_aaaa_b'
  const secrets = await deriveSecretsConfig(
    parseSecretsEnv(secret, undefined, 'workers'),
    'daemon-jwt-signing',
  )
  const issued = await issueDaemonJwt(
    { sub: serverId, kid: keyId },
    secrets,
  )
  return issued.token
}

function cellRpc(
  stub: DurableObjectStub,
  serverId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(CELL_HEADER, serverId)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return stub.fetch(`https://do.internal${path}`, { ...init, headers })
}

async function openDaemonWebSocket(
  stub: DurableObjectStub,
  serverId: string,
  keyId = crypto.randomUUID(),
): Promise<{ ws: WebSocket; token: string; tokenId: string; keyId: string }> {
  const token = await issueTestDaemonJwt(serverId, keyId)
  const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
    headers: {
      Authorization: `Bearer ${token}`,
      Upgrade: 'websocket',
    },
  })
  expect(response.status).toBe(101)
  const ws = response.webSocket
  if (!ws) throw new Error('missing websocket')
  ws.accept()
  return { ws, token, tokenId: decodeJwtJti(token), keyId }
}

function waitForWebSocketMessage(ws: WebSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for websocket message'))
    }, timeoutMs)
    ws.addEventListener('message', (event) => {
      clearTimeout(timer)
      resolve(String(event.data))
    }, { once: true })
  })
}


async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

describe('DaemonCellObject', () => {
  it('accepts hibernation-safe WebSocket attach with valid JWT', async () => {
    const serverId = 'test-srv-1'
    const keyId = crypto.randomUUID()
    const stub = env.DAEMON_CELL.getByName(serverId)

    const { ws, tokenId } = await openDaemonWebSocket(stub, serverId, keyId)

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = await snapshotResponse.json() as {
      connected: boolean
      sessionId?: string
    }
    expect(snapshot.connected).toBe(true)
    expect(snapshot.sessionId).toBe(tokenId)

    ws.close(1000, 'test done')
  })

  it('delivers enqueued commands over websocket and completes on inbound result', async () => {
    const serverId = 'test-srv-outbox'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const { ws } = await openDaemonWebSocket(stub, serverId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    const messagePromise = waitForWebSocketMessage(ws)

    const enqueueResponse = await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command',
          deliveryId,
          requestId,
          at,
          command: 'echo test',
        },
        opts: { ttlSeconds: 300 },
      }),
    })
    expect(enqueueResponse.status).toBe(200)

    const raw = await messagePromise
    const msg = JSON.parse(raw) as {
      type: string
      command?: string
      id?: string
    }
    expect(msg.type).toBe('command')
    expect(msg.command).toBe('echo test')
    expect(msg.id).toBe(requestId)

    ws.send(JSON.stringify({
      type: 'command-result',
      id: requestId,
      exitCode: 0,
      stdout: 'test',
      stderr: '',
      at: new Date().toISOString(),
    }))

    await waitFor(async () => {
      const doneResponse = await cellRpc(
        stub,
        serverId,
        `/rpc/request?requestId=${requestId}`,
        { method: 'GET' },
      )
      const doneBody = await doneResponse.json() as {
        record: { status: string; result?: { stdout: string } }
      }
      expect(doneBody.record.status).toBe('done')
      expect(doneBody.record.result?.stdout).toBe('test')
    })

    ws.close(1000, 'test done')
  })

  it('evicts an existing websocket when a second attach succeeds for the same server', async () => {
    const serverId = 'test-srv-dual'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const first = await openDaemonWebSocket(stub, serverId)
    const second = await openDaemonWebSocket(stub, serverId)

    const snapshotResponse = await cellRpc(stub, serverId, '/rpc/snapshot', {
      method: 'GET',
    })
    const snapshot = await snapshotResponse.json() as {
      connected: boolean
      sessionId?: string
    }
    expect(snapshot.connected).toBe(true)
    expect(snapshot.sessionId).toBe(second.tokenId)

    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()
    let firstReceived = false
    first.ws.addEventListener('message', () => {
      firstReceived = true
    })
    const secondMessagePromise = waitForWebSocketMessage(second.ws)

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command',
          deliveryId,
          requestId,
          at,
          command: 'after-evict',
        },
      }),
    })

    const raw = await secondMessagePromise
    const msg = JSON.parse(raw) as { type: string; command?: string }
    expect(msg.type).toBe('command')
    expect(msg.command).toBe('after-evict')
    expect(firstReceived).toBe(false)

    await waitFor(() => {
      expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(first.ws.readyState)
    })

    second.ws.close(1000, 'test done')
  }, 15_000)

  it('persists outbox requests across RPC calls and stub re-fetch', async () => {
    const serverId = 'test-srv-2'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()
    const deliveryId = generateDeliveryId()
    const at = new Date().toISOString()

    const enqueueResponse = await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command',
          deliveryId,
          requestId,
          at,
          command: 'echo test',
        },
        opts: { ttlSeconds: 300 },
      }),
    })
    expect(enqueueResponse.status).toBe(200)

    const queuedResponse = await cellRpc(
      stub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: 'GET' },
    )
    const queuedBody = await queuedResponse.json() as {
      record: { status: string }
    }
    expect(queuedBody.record.status).toBe('queued')

    await cellRpc(stub, serverId, '/rpc/inbound', {
      method: 'POST',
      body: JSON.stringify({
        inbound: {
          kind: 'command-result',
          requestId,
          at,
          exitCode: 0,
          stdout: 'test',
          stderr: '',
        },
      }),
    })

    const doneResponse = await cellRpc(
      stub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: 'GET' },
    )
    const doneBody = await doneResponse.json() as {
      record: { status: string; result?: { stdout: string } }
    }
    expect(doneBody.record.status).toBe('done')
    expect(doneBody.record.result?.stdout).toBe('test')

    const refetchedStub = env.DAEMON_CELL.getByName(serverId)
    const persistedResponse = await cellRpc(
      refetchedStub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: 'GET' },
    )
    const persistedBody = await persistedResponse.json() as {
      record: { status: string }
    }
    expect(persistedBody.record.status).toBe('done')
  })

  it('prune removes expired request rows', async () => {
    const serverId = 'test-srv-2-alarm'
    const stub = env.DAEMON_CELL.getByName(serverId)
    const requestId = generateRequestId()

    await cellRpc(stub, serverId, '/rpc/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        outbound: {
          kind: 'command',
          deliveryId: generateDeliveryId(),
          requestId,
          at: new Date().toISOString(),
          command: 'short-lived',
        },
        opts: { ttlSeconds: 1 },
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 1100))

    await cellRpc(stub, serverId, '/rpc/prune', {
      method: 'POST',
      body: JSON.stringify({ now: Date.now() + 5000 }),
    })

    const response = await cellRpc(
      stub,
      serverId,
      `/rpc/request?requestId=${requestId}`,
      { method: 'GET' },
    )
    const body = await response.json() as { record: unknown }
    expect(body.record).toBeNull()
  })

  it('getByName accepts location hints and generation suffixes', async () => {
    const stubWithHint = env.DAEMON_CELL.getByName('test-srv-3', {
      locationHint: 'wnam',
    })
    expect(stubWithHint).toBeDefined()

    const generationOne = env.DAEMON_CELL.getByName('test-srv-3')
    const generationTwo = env.DAEMON_CELL.getByName('test-srv-3:g2')
    expect(generationOne.id.toString()).not.toBe(generationTwo.id.toString())
  })

  it('challenge issue and consume are single-use via RPC', async () => {
    const serverId = 'test-srv-challenge'
    const stub = env.DAEMON_CELL.getByName(serverId)

    const issueResponse = await cellRpc(stub, serverId, '/rpc/challenge/issue', {
      method: 'POST',
      body: JSON.stringify({
        serverId: '',
        keyId: '',
        ttlMs: 15_000,
      }),
    })
    expect(issueResponse.status).toBe(200)
    const issued = await issueResponse.json() as {
      id: string
      nonce: string
      at: string
    }
    expect(typeof issued.id).toBe('string')
    expect(typeof issued.nonce).toBe('string')
    expect(typeof issued.at).toBe('string')

    const firstConsume = await cellRpc(
      stub,
      serverId,
      '/rpc/challenge/consume',
      {
        method: 'POST',
        body: JSON.stringify({ challengeId: issued.id }),
      },
    )
    const firstBody = await firstConsume.json() as {
      challenge: { id: string } | null
    }
    expect(firstBody.challenge?.id).toBe(issued.id)

    const secondConsume = await cellRpc(
      stub,
      serverId,
      '/rpc/challenge/consume',
      {
        method: 'POST',
        body: JSON.stringify({ challengeId: issued.id }),
      },
    )
    const secondBody = await secondConsume.json() as {
      challenge: unknown
    }
    expect(secondBody.challenge).toBeNull()
  })
})
