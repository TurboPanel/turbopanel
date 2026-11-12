import { assert, assertEquals, assertRejects } from '@std/assert'
import {
  generateDeliveryId,
  generateRequestId,
  DAEMON_OFFLINE_SWEEP_MS,
  DAEMON_STALE_MS,
} from '../../../contracts/cell-protocol.ts'
import { emptyServerIps } from '../../../contracts/server-addresses.ts'
import { OUTBOX_CONSUMER_SUPERSEDED, RedisDaemonCell } from './cell.ts'
import {
  cellKeyPattern,
  connKey,
  deliveryLeaseKey,
  leaseKey,
  metaKey,
  onlineSetKey,
  OUTBOX_GROUP,
  outboxKey,
  requestKey,
  requestsKey,
  snapshotKey,
} from './keys.ts'
import { createFakeRedisCellClient, type FakeRedisCellClient } from './fake-redis-cell-client.ts'
import type { RedisCellClient } from './client.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createTestCell(serverId?: string): {
  client: FakeRedisCellClient
  cell: RedisDaemonCell
  serverId: string
} {
  const client = createFakeRedisCellClient()
  const id = serverId ?? `fake-${crypto.randomUUID()}`
  return {
    client,
    cell: new RedisDaemonCell(client as unknown as RedisCellClient, id),
    serverId: id,
  }
}

async function cleanupCell(client: FakeRedisCellClient, serverId: string): Promise<void> {
  await client.deleteByPattern(cellKeyPattern(serverId))
  await client.srem(onlineSetKey(), serverId)
}

function assertNoMisattributedStorage(
  storageByCallSite: Record<string, { reads: number; writes: number }>
): void {
  assertEquals(storageByCallSite['unknown'], undefined)
  for (const [callSite, counts] of Object.entries(storageByCallSite)) {
    assert(counts.reads + counts.writes > 0, `expected non-zero storage ops for ${callSite}`)
  }
}

test('attachDaemonSocket acquires lease and marks server online', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({
      keyId: 'key-1',
      remoteAddress: '203.0.113.10',
    })
    assertEquals(typeof attached.connectionId, 'string')
    assertEquals(attached.lease.holder, attached.connectionId)

    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.connected, '1')
    assertEquals(meta?.connectionId, attached.connectionId)
    assertEquals(meta?.remoteAddress, '203.0.113.10')

    const online = await client.smembers(onlineSetKey())
    assertEquals(online.includes(serverId), true)

    const snapshot = await cell.getSnapshot()
    assertEquals(snapshot.connected, true)
    assertEquals(snapshot.remoteAddress, '203.0.113.10')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('second attachDaemonSocket throws while lease is held', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    await cell.attachDaemonSocket({ keyId: 'key-1' })
    await assertRejects(
      () => cell.attachDaemonSocket({ keyId: 'key-2' }),
      Error,
      'daemon socket lease held'
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('detachDaemonSocket releases lease and clears online state', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    await cell.detachDaemonSocket({ connectionId: attached.connectionId })

    assertEquals(await client.get(leaseKey(serverId)), null)
    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.connected, '0')
    assertEquals((await client.smembers(onlineSetKey())).includes(serverId), false)

    const conn = await client.hgetall(connKey(serverId, attached.connectionId))
    assertEquals(typeof conn?.closedAt, 'string')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('recordInbound coalesces rapid pings without daemonBuild', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    // Backdate connectedAt well past the coalesce floor so the first
    // recordInbound below is guaranteed to bump lastInboundAt to `t0`
    // deterministically, instead of racing against attach's own `nowIso()`
    // (which previously made this test flaky by ~1ms when both timestamps
    // landed in the same coalesce window).
    const attached = await cell.attachDaemonSocket({
      keyId: 'key-1',
      connectedAt: new Date(Date.now() - 120_000).toISOString(),
    })
    const t0 = new Date().toISOString()
    await cell.recordInbound({ connectionId: attached.connectionId, at: t0 })
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date(Date.parse(t0) + 5_000).toISOString(),
    })

    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.lastInboundAt, t0)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('recordInbound stores daemonBuild changes', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const at = new Date().toISOString()
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at,
      daemonBuild: {
        commit: 'abc123',
        buildId: 'build-1',
        channel: 'trunk',
      },
    })

    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.daemonBuild?.includes('abc123'), true)
    const snapshot = await cell.getSnapshot()
    assertEquals(snapshot.daemonBuild?.commit, 'abc123')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('enqueue markSent and handleInbound complete command lifecycle', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()
    const at = new Date().toISOString()

    const queued = await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId,
      requestId,
      at,
      commandId: 'cmd-1',
      commandType: 'daemon.ping',
      payload: {},
    })
    assertEquals(queued.status, 'queued')
    assertEquals(await client.zcard(requestsKey(serverId)), 1)

    await cell.markSent(deliveryId, 'conn-1', at)
    const sent = await cell.getRequest(requestId)
    assertEquals(sent?.status, 'sent')

    const acked = await cell.handleInbound({
      kind: 'command-ack',
      requestId,
      at,
      daemonReceivedAt: at,
    })
    assertEquals(acked?.status, 'acked')

    const done = await cell.handleInbound({
      kind: 'command-outcome',
      requestId,
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    })
    assertEquals(done?.status, 'done')
    assertEquals(done?.result, { pong: true })
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('handleInbound refuses an answer of another kind and keeps the request pending', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId,
      requestId,
      at,
      commandId: 'cmd-1',
      commandType: 'managed.lifecycle',
      payload: {},
    })
    await cell.markSent(deliveryId, 'conn-1', at)

    // An unsigned answer frame of another kind that names the command's id.
    const forged = await cell.handleInbound({ kind: 'dev-sync-result', requestId, at, ok: true })
    assertEquals(forged, null)
    assertEquals((await cell.getRequest(requestId))?.status, 'sent')

    const done = await cell.handleInbound({
      kind: 'command-outcome',
      requestId,
      at,
      ok: false,
      error: 'stop failed',
    })
    assertEquals(done?.status, 'failed')
    assertEquals(done?.error, 'stop failed')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('handleInbound refuses command-ack and command-outcome for a request that is not a command', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'managed-health-request',
      deliveryId,
      requestId,
      at,
      managedId: 'managed-1',
      memberId: 'member-1',
      role: 'replica',
      engine: 'mysql',
    })
    await cell.markSent(deliveryId, 'conn-1', at)

    assertEquals(
      await cell.handleInbound({ kind: 'command-ack', requestId, at, daemonReceivedAt: at }),
      null
    )
    assertEquals(
      await cell.handleInbound({ kind: 'command-outcome', requestId, at, ok: true }),
      null
    )
    const pending = await cell.getRequest(requestId)
    assertEquals(pending?.status, 'sent')
    assertEquals(pending?.ackAt, undefined)

    const done = await cell.handleInbound({
      kind: 'managed-health-result',
      requestId,
      at,
      ok: false,
      error: 'engine not answering',
    })
    assertEquals(done?.status, 'failed')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('readOutboxBatch and ackOutbox deliver and acknowledge outbox entries', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()
    const at = new Date().toISOString()

    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId,
      requestId,
      at,
      commandId: 'cmd-outbox',
      commandType: 'daemon.ping',
      payload: {},
    })

    const consumer = `ws:${attached.connectionId}`
    const batch = await cell.readOutboxBatch({ consumer, count: 10 })
    assertEquals(batch.length, 1)
    assertEquals(batch[0]?.requestId, requestId)

    await cell.ackOutbox([deliveryId], consumer)
    assertEquals(await client.xlen(outboxKey(serverId)), 0)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('delivery lease claim renew and release', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const first = await cell.claimDeliveryLease('holder-a', 30_000)
    assertExistsLease(first, 'holder-a')

    const blocked = await cell.claimDeliveryLease('holder-b', 30_000)
    assertEquals(blocked, null)

    const renewed = await cell.renewDeliveryLease('holder-a', 30_000)
    assertExistsLease(renewed, 'holder-a')

    await cell.releaseDeliveryLease('holder-a')
    assertEquals(await client.get(deliveryLeaseKey(serverId)), null)

    const second = await cell.claimDeliveryLease('holder-b', 30_000)
    assertExistsLease(second, 'holder-b')
  } finally {
    await cleanupCell(client, serverId)
  }
})

function assertExistsLease(
  lease: { holder: string; expiresAt: string } | null,
  holder: string
): void {
  if (lease == null) throw new TypeError('expected lease')
  assertEquals(lease.holder, holder)
  assertEquals(typeof lease.expiresAt, 'string')
}

test('reconcileStalePresence demotes stale connected servers', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const staleAt = new Date(Date.now() - DAEMON_OFFLINE_SWEEP_MS - 60_000).toISOString()
    await client.setnxPersistent(leaseKey(serverId), 'orphan-conn')
    await client.hset(metaKey(serverId), {
      connected: '1',
      connectionId: 'orphan-conn',
      connectedAt: staleAt,
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    })
    await client.sadd(onlineSetKey(), serverId)

    const demoted = await cell.reconcileStalePresence()
    assertEquals(demoted, true)

    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.connected, '0')
    assertEquals((await client.smembers(onlineSetKey())).includes(serverId), false)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('reclaimOrphanedSocketLeaseOnStartup clears orphan lease', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const holder = 'restart-conn'
    await client.setnxPersistent(leaseKey(serverId), holder)
    await client.hset(metaKey(serverId), {
      connected: '1',
      connectionId: holder,
      connectedAt: new Date().toISOString(),
    })
    await client.sadd(onlineSetKey(), serverId)

    await cell.reclaimOrphanedSocketLeaseOnStartup()

    assertEquals(await client.get(leaseKey(serverId)), null)
    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.connected, '0')
    const conn = await client.hgetall(connKey(serverId, holder))
    assertEquals(conn?.reason, 'instance-restart')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('createRequestAndWait returns expired when daemon never responds', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    const result = await cell.createRequestAndWait(
      {
        kind: 'tunnel-token',
        deliveryId: generateDeliveryId(),
        requestId,
        at,
        token: 'test-token',
      },
      50
    )
    assertEquals(result.status, 'expired')
    assertEquals(await client.hgetall(requestKey(serverId, requestId)), null)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('prune removes expired non-update requests', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const expiredAt = new Date(Date.now() - 60_000).toISOString()
    await client.hset(requestKey(serverId, requestId), {
      requestId,
      requestKind: 'tunnel-token',
      status: 'queued',
      createdAt: expiredAt,
      expiresAt: expiredAt,
      deliveries: '{}',
    })
    await client.zadd(requestsKey(serverId), Date.parse(expiredAt), requestId)

    const expired = await cell.prune()
    assertEquals(expired.length, 0)
    assertEquals(await client.hgetall(requestKey(serverId, requestId)), null)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('listRequests filters by requestKind', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const pingId = generateRequestId()
    const syncId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId: pingId,
      at,
      commandId: 'c1',
      commandType: 'daemon.ping',
      payload: {},
    })
    await cell.enqueue({
      kind: 'dev-sync',
      deliveryId: generateDeliveryId(),
      requestId: syncId,
      at,
      phase: 'begin',
      totalChunks: 1,
      totalBytes: 100,
    })

    const commands = await cell.listRequests(10, {
      requestKind: 'command-dispatch',
    })
    assertEquals(commands.length, 1)
    assertEquals(commands[0]?.requestId, pingId)
    assertEquals(await client.zcard(requestsKey(serverId)), 2)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('purge wipes all cell keys for the server', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      commandId: 'c1',
      commandType: 'daemon.ping',
      payload: {},
    })
    await client.sadd(onlineSetKey(), serverId)

    await cell.purge()

    assertEquals((await client.scanKeys(cellKeyPattern(serverId))).length, 0)
    assertEquals((await client.smembers(onlineSetKey())).includes(serverId), false)
    assertEquals(attached.connectionId.length > 0, true)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('getDiagnostics returns redis counters after attach inbound enqueue detach', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: crypto.randomUUID() })
    const at = new Date(Date.now() + 65_000).toISOString()
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at,
      daemonBuild: { commit: 'diag', buildId: 'b1' },
    })
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      commandId: 'diag-fake',
      commandType: 'ping',
      payload: {},
    })
    await cell.detachDaemonSocket({ connectionId: attached.connectionId })

    const diag = await cell.getDiagnostics()
    assertEquals(diag.backend, 'redis')
    assertEquals(diag.usesHibernationWebSocket, false)
    assertEquals(diag.constructorCalls, 1)
    assert(diag.wsAccepted >= 1)
    assert(diag.heartbeatCount >= 1)
    assert(diag.commandDispatchCount >= 1)
    assert(diag.wsClosed >= 1)
    assert(diag.cleanupCount >= 1)
    assertEquals(typeof diag.fetchByRoute.attachDaemonSocket, 'number')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('getDiagnostics populates storage counters when TURBOPANEL_DAEMON_DEBUG is enabled', async () => {
  const prev = Deno.env.get('TURBOPANEL_DAEMON_DEBUG')
  Deno.env.set('TURBOPANEL_DAEMON_DEBUG', '1')
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: crypto.randomUUID() })
    await cell.recordInbound({
      connectionId: attached.connectionId,
      at: new Date().toISOString(),
    })
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId: generateRequestId(),
      at: new Date().toISOString(),
      commandId: 'diag-fake-debug',
      commandType: 'ping',
      payload: {},
    })

    const diag = await cell.getDiagnostics()
    assert(diag.storageReads > 0)
    assert(diag.storageWrites > 0)
    assert(Object.keys(diag.storageByCallSite).length > 0)
    assertNoMisattributedStorage(diag.storageByCallSite)
  } finally {
    if (prev === undefined) {
      Deno.env.delete('TURBOPANEL_DAEMON_DEBUG')
    } else {
      Deno.env.set('TURBOPANEL_DAEMON_DEBUG', prev)
    }
    await cleanupCell(client, serverId)
  }
})

test('handleInbound rejects invalid envelopes', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      commandId: 'c1',
      commandType: 'daemon.ping',
      payload: {},
    })

    const rejected = await cell.handleInbound({
      kind: 'command-ack',
      requestId: 'not-a-valid-id',
      at,
      daemonReceivedAt: at,
    })
    assertEquals(rejected, null)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('putSnapshot increments version and persists JSON snapshot', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const first = await cell.putSnapshot({ connected: true })
    assertEquals(first.version, 1)
    const second = await cell.putSnapshot({ remoteAddress: '203.0.113.20' })
    assertEquals(second.version, 2)
    assertEquals(second.remoteAddress, '203.0.113.20')

    const loaded = await cell.getSnapshot()
    assertEquals(loaded.version, 2)
    assertEquals(loaded.remoteAddress, '203.0.113.20')
    assertEquals((await client.get(snapshotKey(serverId))) != null, true)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('attachDaemonSocket reclaims stale lease and allows reconnect', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const staleHolder = 'stale-conn'
    const staleAt = new Date(Date.now() - DAEMON_STALE_MS - 5_000).toISOString()
    await client.setnxPersistent(leaseKey(serverId), staleHolder)
    await client.hset(metaKey(serverId), {
      connected: '1',
      connectionId: staleHolder,
      connectedAt: staleAt,
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
    })
    await client.sadd(onlineSetKey(), serverId)

    const attached = await cell.attachDaemonSocket({ keyId: 'key-fresh' })
    assertEquals(typeof attached.connectionId, 'string')
    assertEquals(attached.connectionId !== staleHolder, true)
    assertEquals(await client.get(leaseKey(serverId)), attached.connectionId)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('detachDaemonSocket ignores wrong connectionId', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    await cell.detachDaemonSocket({ connectionId: 'wrong-connection-id' })
    assertEquals(await client.get(leaseKey(serverId)), attached.connectionId)
    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.connected, '1')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('enqueue is idempotent for duplicate deliveryId and adds new deliveries', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const deliveryA = generateDeliveryId()
    const deliveryB = generateDeliveryId()
    const at = new Date().toISOString()
    const base = {
      requestId,
      at,
      commandId: 'cmd-dup',
      commandType: 'daemon.ping',
      payload: {},
    }

    await cell.enqueue({ kind: 'command-dispatch', deliveryId: deliveryA, ...base })
    const dup = await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: deliveryA,
      ...base,
    })
    assertEquals(dup.status, 'queued')
    assertEquals(await client.xlen(outboxKey(serverId)), 1)

    await cell.enqueue({ kind: 'command-dispatch', deliveryId: deliveryB, ...base })
    assertEquals(await client.xlen(outboxKey(serverId)), 2)
    const fields = await client.hgetall(requestKey(serverId, requestId))
    const deliveries = JSON.parse(fields?.deliveries ?? '{}') as Record<string, string>
    assertEquals(Object.keys(deliveries).length, 2)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('createRequestAndWait returns terminal record on daemon response', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    const waitPromise = cell.createRequestAndWait(
      {
        kind: 'tunnel-token',
        deliveryId: generateDeliveryId(),
        requestId,
        at,
        token: 'wait-token',
      },
      5_000
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    await cell.handleInbound({
      kind: 'tunnel-token-result',
      requestId,
      at,
      ok: true,
    })
    const result = await waitPromise
    assertEquals(result.status, 'done')
    assertEquals(result.requestKind, 'tunnel-token')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('waitForRequest resolves when request reaches terminal status', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'tunnel-token',
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      token: 'poll-token',
    })
    const waitPromise = cell.waitForRequest(requestId, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await cell.handleInbound({
      kind: 'tunnel-token-result',
      requestId,
      at,
      ok: true,
    })
    const result = await waitPromise
    if (result == null) throw new TypeError('expected terminal record')
    assertEquals(result.status, 'done')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('handleInbound completes addresses dev-sync and managed-logs requests', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const at = new Date().toISOString()
    const addressesId = generateRequestId()
    await cell.enqueue({
      kind: 'addresses-request',
      deliveryId: generateDeliveryId(),
      requestId: addressesId,
      at,
    })
    const ips = [
      ...emptyServerIps(),
      { address: '203.0.113.50', version: 4 as const, scope: 'public' as const },
    ]
    const addrDone = await cell.handleInbound({
      kind: 'addresses-result',
      requestId: addressesId,
      at,
      ips,
    })
    assertEquals(addrDone?.status, 'done')
    const snapshot = await cell.getSnapshot()
    assertEquals(snapshot.ips?.find((ip) => ip.scope === 'public')?.address, '203.0.113.50')

    const syncId = generateRequestId()
    await cell.enqueue({
      kind: 'dev-sync',
      deliveryId: generateDeliveryId(),
      requestId: syncId,
      at,
      phase: 'begin',
      totalChunks: 1,
      totalBytes: 10,
    })
    const syncFailed = await cell.handleInbound({
      kind: 'dev-sync-result',
      requestId: syncId,
      at,
      ok: false,
      error: 'sync failed',
    })
    assertEquals(syncFailed?.status, 'failed')
    assertEquals(syncFailed?.error, 'sync failed')

    const logsId = generateRequestId()
    await cell.enqueue({
      kind: 'managed-logs-request',
      deliveryId: generateDeliveryId(),
      requestId: logsId,
      at,
      managedId: 'managed-1',
      tail: 100,
    })
    const logsDone = await cell.handleInbound({
      kind: 'managed-logs-result',
      requestId: logsId,
      at,
      logs: 'line1\nline2',
    })
    assertEquals(logsDone?.status, 'done')
    assertEquals(logsDone?.result, { logs: 'line1\nline2' })
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('handleInbound correlates fabric-paths-result done and failed', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const at = new Date().toISOString()
    const doneId = generateRequestId()
    await cell.enqueue({
      kind: 'fabric-paths-request',
      deliveryId: generateDeliveryId(),
      requestId: doneId,
      at,
      fabricId: '00000000-0000-4000-8000-000000000001',
      probeMs: 0,
      candidates: [],
    })
    const done = await cell.handleInbound({
      kind: 'fabric-paths-result',
      requestId: doneId,
      at,
      paths: [
        {
          publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          endpoint: '203.0.113.50:48172',
          health: 'healthy',
        },
      ],
    })
    assertEquals(done?.status, 'done')
    assertEquals(done?.result, {
      paths: [
        {
          publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          endpoint: '203.0.113.50:48172',
          health: 'healthy',
        },
      ],
    })

    const failId = generateRequestId()
    await cell.enqueue({
      kind: 'fabric-paths-request',
      deliveryId: generateDeliveryId(),
      requestId: failId,
      at,
      fabricId: '00000000-0000-4000-8000-000000000001',
      probeMs: 0,
      candidates: [],
    })
    const failed = await cell.handleInbound({
      kind: 'fabric-paths-result',
      requestId: failId,
      at,
      paths: [],
      error: 'wg dump failed',
    })
    assertEquals(failed?.status, 'failed')
    assertEquals(failed?.error, 'wg dump failed')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('handleInbound applies late command-ack on terminal request', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      commandId: 'late-ack',
      commandType: 'daemon.ping',
      payload: {},
    })
    await cell.handleInbound({
      kind: 'command-outcome',
      requestId,
      at,
      ok: true,
      result: { ok: true },
      daemonReceivedAt: at,
      daemonRespondedAt: at,
    })
    const late = await cell.handleInbound({
      kind: 'command-ack',
      requestId,
      at,
      daemonReceivedAt: at,
    })
    assertEquals(late?.ackAt, at)
    assertEquals(late?.status, 'done')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('handleInbound returns existing acked record on duplicate command-ack', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      commandId: 'dup-ack',
      commandType: 'daemon.ping',
      payload: {},
    })
    const acked = await cell.handleInbound({
      kind: 'command-ack',
      requestId,
      at,
      daemonReceivedAt: at,
    })
    assertEquals(acked?.status, 'acked')
    const again = await cell.handleInbound({
      kind: 'command-ack',
      requestId,
      at,
      daemonReceivedAt: at,
    })
    assertEquals(again?.status, 'acked')
    assertEquals(again?.ackAt, acked?.ackAt)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('markSent sets sentAt when omitted', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId,
      requestId,
      at,
      commandId: 'sent-at',
      commandType: 'daemon.ping',
      payload: {},
    })
    await cell.markSent(deliveryId, 'conn-1')
    const record = await cell.getRequest(requestId)
    assertEquals(record?.status, 'sent')
    assertEquals(typeof record?.sentAt, 'string')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('renewDeliveryLease returns null for wrong holder', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    await cell.claimDeliveryLease('holder-a', 30_000)
    const renewed = await cell.renewDeliveryLease('holder-b', 30_000)
    assertEquals(renewed, null)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('ackOutbox resolves stream id from request hash without in-memory cache', async () => {
  const client = createFakeRedisCellClient()
  const serverId = `ack-lookup-${crypto.randomUUID()}`
  const cellA = new RedisDaemonCell(client as unknown as RedisCellClient, serverId)
  const cellB = new RedisDaemonCell(client as unknown as RedisCellClient, serverId)
  try {
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cellA.enqueue({
      kind: 'command-dispatch',
      deliveryId,
      requestId,
      at,
      commandId: 'ack-lookup',
      commandType: 'daemon.ping',
      payload: {},
    })
    assertEquals(await client.xlen(outboxKey(serverId)), 1)
    await cellB.ackOutbox([deliveryId], 'consumer-b')
    assertEquals(await client.xlen(outboxKey(serverId)), 0)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('readOutboxBatch serves xautoclaimed entries on attach', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const first = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const deliveryId = generateDeliveryId()
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'command-dispatch',
      deliveryId,
      requestId,
      at,
      commandId: 'reclaim',
      commandType: 'daemon.ping',
      payload: {},
    })
    const consumerA = `ws:${first.connectionId}`
    await cell.readOutboxBatch({ consumer: consumerA, count: 10 })
    const entries = await client.xrange(outboxKey(serverId), '-', '+')
    assertEquals(entries.length, 1)
    client.ageStreamPendingIdle(outboxKey(serverId), OUTBOX_GROUP, entries[0]!.id, 61_000)
    await cell.detachDaemonSocket({ connectionId: first.connectionId })

    const second = await cell.attachDaemonSocket({ keyId: 'key-2' })
    const batch = await cell.readOutboxBatch({
      consumer: `ws:${second.connectionId}`,
      count: 10,
    })
    assert(batch.some((entry) => entry.requestId === requestId))
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('attach claims an entry the old socket read a moment before the reconnect', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const first = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const dispatch = pingDispatch('read-just-before-reconnect')
    await cell.enqueue(dispatch)
    // The old socket's pump read it, then the socket went away: the entry is
    // pending on the old consumer and only a moment idle.
    await cell.readOutboxBatch({ consumer: `ws:${first.connectionId}`, count: 10 })
    await cell.detachDaemonSocket({ connectionId: first.connectionId })

    const second = await cell.attachDaemonSocket({ keyId: 'key-2' })
    const batch = await cell.readOutboxBatch({ consumer: `ws:${second.connectionId}`, count: 10 })
    assertEquals(
      batch.map((entry) => entry.requestId),
      [dispatch.requestId]
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('a socket replaced by a stale takeover can no longer take outbox entries', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const old = await cell.attachDaemonSocket({ keyId: 'key-1' })
    // The old socket went quiet (half open); the daemon reconnected.
    const staleAt = new Date(Date.now() - DAEMON_STALE_MS - 5_000).toISOString()
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
      connectedAt: staleAt,
    })
    const fresh = await cell.attachDaemonSocket({ keyId: 'key-2' })

    const dispatch = pingDispatch('after-takeover')
    await cell.enqueue(dispatch)

    // The old pump is still looping on its dead socket; it must be told to stop
    // and leave the entry for the live socket.
    await assertRejects(
      () => cell.readOutboxBatch({ consumer: `ws:${old.connectionId}`, count: 10 }),
      Error,
      OUTBOX_CONSUMER_SUPERSEDED
    )
    const batch = await cell.readOutboxBatch({ consumer: `ws:${fresh.connectionId}`, count: 10 })
    assertEquals(
      batch.map((entry) => entry.requestId),
      [dispatch.requestId]
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('an entry handed to the old socket by a read parked across the takeover goes to the live socket', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const old = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const oldConsumer = `ws:${old.connectionId}`

    // The old pump is parked in its blocking read: it passed the entry check,
    // and the broker answers only after the takeover and an enqueue.
    const realRead = client.xreadgroup.bind(client)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    client.xreadgroup = async (group, consumer, streamKey, count, blockMs, streamId) => {
      if (consumer === oldConsumer && streamId === '>') await gate
      return realRead(group, consumer, streamKey, count, blockMs, streamId)
    }
    const oldRead = cell.readOutboxBatch({ consumer: oldConsumer, count: 10 })
    // Let it get past the entry check and park.
    for (let i = 0; i < 20; i += 1) await Promise.resolve()

    const staleAt = new Date(Date.now() - DAEMON_STALE_MS - 5_000).toISOString()
    await client.hset(metaKey(serverId), {
      lastInboundAt: staleAt,
      lastSeenAt: staleAt,
      connectedAt: staleAt,
    })
    const fresh = await cell.attachDaemonSocket({ keyId: 'key-2' })
    const dispatch = pingDispatch('read-while-parked')
    await cell.enqueue(dispatch)
    release()

    await assertRejects(() => oldRead, Error, OUTBOX_CONSUMER_SUPERSEDED)
    const batch = await cell.readOutboxBatch({ consumer: `ws:${fresh.connectionId}`, count: 10 })
    assertEquals(
      batch.map((entry) => entry.requestId),
      [dispatch.requestId]
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

function pingDispatch(commandId: string) {
  return {
    kind: 'command-dispatch' as const,
    deliveryId: generateDeliveryId(),
    requestId: generateRequestId(),
    at: new Date().toISOString(),
    commandId,
    commandType: 'daemon.ping',
    payload: {},
  }
}

test('readOutboxBatch creates the outbox group again after Redis lost it and delivers what was queued meanwhile', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const consumer = `ws:${attached.connectionId}`

    // Redis restarted without its data: the stream and its group are gone
    // while the socket stays open.
    await client.del(outboxKey(serverId))
    await assertRejects(
      () => client.xreadgroup(OUTBOX_GROUP, consumer, outboxKey(serverId), 1),
      Error,
      'NOGROUP'
    )

    // A command queued before any read recreates the stream without a group.
    const queued = pingDispatch('after-loss')
    await cell.enqueue(queued)

    const batch = await cell.readOutboxBatch({ consumer, count: 10 })
    assertEquals(
      batch.map((entry) => entry.requestId),
      [queued.requestId]
    )

    // Delivery goes on as before: ack, then the next command.
    await cell.ackOutbox([queued.deliveryId], consumer)
    assertEquals(await client.xlen(outboxKey(serverId)), 0)
    const next = pingDispatch('next')
    await cell.enqueue(next)
    const second = await cell.readOutboxBatch({ consumer, count: 10 })
    assertEquals(
      second.map((entry) => entry.requestId),
      [next.requestId]
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('readOutboxBatch on an idle server recovers a lost outbox group with nothing queued', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const consumer = `ws:${attached.connectionId}`
    await client.del(outboxKey(serverId))

    assertEquals(await cell.readOutboxBatch({ consumer, count: 10 }), [])
    // The group exists again, so the next read is an ordinary one.
    assertEquals(await client.xreadgroup(OUTBOX_GROUP, consumer, outboxKey(serverId), 1), [])
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('an unacknowledged entry is delivered again after the outbox group was lost', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const consumer = `ws:${attached.connectionId}`
    const sent = pingDispatch('sent-not-acked')
    await cell.enqueue(sent)
    assertEquals((await cell.readOutboxBatch({ consumer, count: 10 })).length, 1)

    // Only the group is gone (the stream kept its entry): the entry was read
    // but never acknowledged, so it is owed to the server once more.
    const entries = await client.xrange(outboxKey(serverId), '-', '+')
    await client.del(outboxKey(serverId))
    await client.xadd(outboxKey(serverId), entries[0]!.id, entries[0]!.fields)

    const again = await cell.readOutboxBatch({ consumer, count: 10 })
    assertEquals(
      again.map((entry) => entry.requestId),
      [sent.requestId]
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('attach delivers entries queued while no outbox group existed', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    // Queued with no group at all (Redis lost its data while the server was
    // away): the first attach must not skip it.
    const queued = pingDispatch('before-attach')
    await cell.enqueue(queued)

    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const batch = await cell.readOutboxBatch({
      consumer: `ws:${attached.connectionId}`,
      count: 10,
    })
    assertEquals(
      batch.map((entry) => entry.requestId),
      [queued.requestId]
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('a purged cell does not bring its outbox back until the next attach', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const consumer = `ws:${attached.connectionId}`
    await cell.purge()

    await assertRejects(() => cell.readOutboxBatch({ consumer, count: 10 }), Error, 'NOGROUP')
    assertEquals(await client.scanKeys(cellKeyPattern(serverId)), [])

    const again = await cell.attachDaemonSocket({ keyId: 'key-2' })
    assertEquals(
      await cell.readOutboxBatch({
        consumer: `ws:${again.connectionId}`,
        count: 10,
      }),
      []
    )
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('a read error other than a missing group is passed on unchanged', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    const xreadgroup = client.xreadgroup.bind(client)
    let groupCreates = 0
    const xgroupCreate = client.xgroupCreate.bind(client)
    client.xgroupCreate = (...args: Parameters<typeof xgroupCreate>) => {
      groupCreates += 1
      return xgroupCreate(...args)
    }
    client.xreadgroup = () => Promise.reject(new Error('WRONGTYPE Operation against a key'))
    await assertRejects(
      () =>
        cell.readOutboxBatch({
          consumer: `ws:${attached.connectionId}`,
          count: 10,
        }),
      Error,
      'WRONGTYPE'
    )
    assertEquals(groupCreates, 0)
    client.xreadgroup = xreadgroup
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('getSnapshot falls back to meta and ignores invalid JSON snapshot', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    await client.set(snapshotKey(serverId), '{not-json')
    await client.hset(metaKey(serverId), {
      connected: '1',
      remoteAddress: '203.0.113.77',
      snapshotVersion: '3',
      updatedAt: new Date().toISOString(),
    })
    const snapshot = await cell.getSnapshot()
    assertEquals(snapshot.connected, true)
    assertEquals(snapshot.remoteAddress, '203.0.113.77')
    assertEquals(snapshot.version, 3)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('recordInbound marks disconnected meta online again', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const attached = await cell.attachDaemonSocket({ keyId: 'key-1' })
    await client.hset(metaKey(serverId), { connected: '0' })
    const at = new Date(Date.now() + 65_000).toISOString()
    await cell.recordInbound({ connectionId: attached.connectionId, at })
    const meta = await client.hgetall(metaKey(serverId))
    assertEquals(meta?.connected, '1')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('clearUpdateStatus purges terminal updates and expires stale in-flight rows', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const doneId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'update',
      deliveryId: generateDeliveryId(),
      requestId: doneId,
      at,
      channel: 'trunk',
    })
    await cell.handleInbound({
      kind: 'update-result',
      requestId: doneId,
      at,
      ok: true,
    })
    const clearedTerminal = await cell.clearUpdateStatus()
    assertEquals(clearedTerminal.cleared, 1)
    assertEquals(await client.hgetall(requestKey(serverId, doneId)), null)

    const staleId = generateRequestId()
    const queuedAt = new Date(Date.now() - 120_000).toISOString()
    await client.hset(requestKey(serverId, staleId), {
      requestId: staleId,
      requestKind: 'update',
      status: 'sent',
      createdAt: queuedAt,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      deliveries: '{}',
    })
    await client.zadd(requestsKey(serverId), Date.now(), staleId)

    const clearedStale = await cell.clearUpdateStatus({
      allowStale: true,
      updateTtlMs: 60_000,
      queuedAt,
    })
    assertEquals(clearedStale.cleared, 1)
    assertEquals(await client.hgetall(requestKey(serverId, staleId)), null)
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('clearUpdateStatus throws when update is in progress', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const requestId = generateRequestId()
    const at = new Date().toISOString()
    await cell.enqueue({
      kind: 'update',
      deliveryId: generateDeliveryId(),
      requestId,
      at,
      channel: 'trunk',
    })
    await assertRejects(() => cell.clearUpdateStatus(), Error, 'update in progress')
  } finally {
    await cleanupCell(client, serverId)
  }
})

test('prune reports expired updates and purges orphan index entries', async () => {
  const { client, cell, serverId } = createTestCell()
  try {
    const orphanId = crypto.randomUUID()
    await client.zadd(requestsKey(serverId), Date.now(), orphanId)

    const updateId = generateRequestId()
    const expiredAt = new Date(Date.now() - 60_000).toISOString()
    await client.hset(requestKey(serverId, updateId), {
      requestId: updateId,
      requestKind: 'update',
      status: 'sent',
      createdAt: expiredAt,
      expiresAt: expiredAt,
      deliveries: '{}',
    })
    await client.zadd(requestsKey(serverId), Date.parse(expiredAt), updateId)

    const expiredUpdates = await cell.prune()
    assertEquals(expiredUpdates.length, 1)
    assertEquals(expiredUpdates[0]?.requestId, updateId)
    assertEquals(await client.zcard(requestsKey(serverId)), 0)
    assertEquals(await client.hgetall(requestKey(serverId, updateId)), null)
  } finally {
    await cleanupCell(client, serverId)
  }
})
